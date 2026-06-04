import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Direction, Prisma, Role, StudentStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isElevated } from '../auth/role-utils';

function generatePassword(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const CABINET_BY_DIRECTION: Record<Direction, number> = {
  BACHELOR: 1,
  MASTER: 2,
  LANGUAGE: 3,
  LANGUAGE_COLLEGE: 4,
  LANGUAGE_BACHELOR: 5,
  COLLEGE: 6,
};

const STUDENT_INCLUDE = {
  documents: true,
  manager: { select: { id: true, fullName: true, email: true } },
  chinaManager: { select: { id: true, fullName: true, email: true } },
  program: true,
  applications: { orderBy: { createdAt: 'desc' as const } },
} as const;

type CurrentUser = { id: string; role: Role };

@Injectable()
export class StudentsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private activity: ActivityService,
    private notifications: NotificationsService,
  ) {}

  private ensureCanEdit(
    student: { managerId: string | null; chinaManagerId?: string | null },
    user: CurrentUser,
  ) {
    if (user.role === 'ADMIN') return;
    const assigned = student.managerId || student.chinaManagerId;
    if (!assigned) return;
    if (student.managerId === user.id || student.chinaManagerId === user.id) return;
    throw new ForbiddenException(
      'Только назначенные менеджеры или администратор могут редактировать этого студента',
    );
  }

  async create(dto: CreateStudentDto, _user?: CurrentUser) {
    const cabinet = dto.cabinet ?? CABINET_BY_DIRECTION[dto.direction];
    const emailNormalized = dto.email.trim().toLowerCase();

    // Проверяем уникальность email среди студентов и пользователей
    const dupStudent = await this.prisma.student.findFirst({ where: { email: emailNormalized } });
    if (dupStudent) {
      throw new BadRequestException('Студент с таким email уже существует');
    }
    const dupUser = await this.prisma.user.findUnique({ where: { email: emailNormalized } });
    if (dupUser) {
      throw new BadRequestException('Этот email уже занят сотрудником');
    }

    // Генерим пароль, сохраняем хеш, возвращаем plain-текст один раз
    const plainPassword = generatePassword(8);
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    const student = await this.prisma.student.create({
      data: {
        fullName: dto.fullName.trim(),
        phones: dto.phones?.length ? dto.phones : [],
        phoneLabels: dto.phoneLabels?.length ? dto.phoneLabels : [],
        preferredChannel: dto.preferredChannel ?? null,
        email: emailNormalized,
        password: passwordHash,
        photoUrl: dto.photoUrl || null,
        direction: dto.direction,
        cabinet,
        status: dto.status ?? StudentStatus.ACTIVE,
        comment: dto.comment || null,
      },
      include: STUDENT_INCLUDE,
    });

    // Автосоздаём связанную заявку со статусом NEW, чтобы степпер этапов был
    // доступен сразу. Это нужно для студентов, заведённых вручную через CRM.
    const application = await this.prisma.application.create({
      data: {
        fullName: student.fullName,
        phone: student.phones[0] || '',
        email: student.email,
        direction: student.direction,
        comment: student.comment,
        status: 'NEW',
        studentId: student.id,
      },
    });

    // Сообщаем staff, что появилась новая заявка — чтобы открытый /applications
    // у других менеджеров обновился без F5
    this.realtime.emitStaff('application:new', { application });
    this.realtime.emitStaff('student:created', { studentId: student.id });

    // Перечитываем студента уже с заявкой
    const withApp = await this.prisma.student.findUnique({
      where: { id: student.id },
      include: STUDENT_INCLUDE,
    });

    return { ...(withApp || student), plainPassword };
  }

  /**
   * Гарантирует, что у студента есть хотя бы одна заявка. Если нет — создаёт
   * новую со статусом NEW. Используется для студентов, заведённых вручную
   * до того, как авто-создание заявки появилось в коде.
   */
  async ensureApplication(id: string, user: CurrentUser) {
    const student = await this.findOne(id);
    this.ensureCanEdit(student, user);
    const existing = await this.prisma.application.findFirst({
      where: { studentId: id },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return existing;
    }
    const created = await this.prisma.application.create({
      data: {
        fullName: student.fullName,
        phone: student.phones[0] || '',
        email: student.email,
        direction: student.direction,
        comment: student.comment,
        status: 'NEW',
        studentId: id,
      },
    });
    this.realtime.emitStaff('application:new', { application: created });
    this.realtime.emitStudent(id, 'student:updated', { studentId: id });
    return created;
  }

  async regeneratePassword(id: string, user: CurrentUser) {
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Только администратор может сбрасывать пароль студента');
    }
    const existing = await this.findOne(id);
    if (!existing.email) {
      throw new BadRequestException('У студента нет email — невозможно создать доступ');
    }
    const plainPassword = generatePassword(8);
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    await this.prisma.student.update({ where: { id }, data: { password: passwordHash } });
    return { email: existing.email, password: plainPassword };
  }

  async findAll(filters: {
    direction?: Direction;
    status?: StudentStatus;
    cabinet?: number;
    search?: string;
    mine?: boolean;
    managerUserId?: string;
    currentUserId?: string;
    currentUserRole?: Role;
    currentUserRoles?: Role[];
    // По ТЗ: «база студентов — только оплатившие». Фильтр включается
    // как ?paid=true с фронтенда (отдельная вкладка/режим).
    paid?: boolean;
  }) {
    const where: Prisma.StudentWhereInput = {};
    if (filters.direction) where.direction = filters.direction;
    if (filters.status) where.status = filters.status;
    if (filters.cabinet) where.cabinet = filters.cabinet;
    // «Оплатил» = есть хотя бы одна INCOME-транзакция категории TUITION_PAYMENT,
    // привязанная к этому студенту.
    if (filters.paid === true) {
      where.transactions = {
        some: { type: 'INCOME', category: 'TUITION_PAYMENT' },
      };
    } else if (filters.paid === false) {
      where.transactions = {
        none: { type: 'INCOME', category: 'TUITION_PAYMENT' },
      };
    }
    const and: Prisma.StudentWhereInput[] = [];
    // Менеджеры (SALES_MANAGER/CLIENT_MANAGER) всегда видят только своих,
    // независимо от mine. Elevated (FOUNDER/ADMIN/ACCOUNTANT) — всех.
    const elevated = isElevated({
      role: filters.currentUserRole,
      roles: filters.currentUserRoles,
    });
    const restrictToMine =
      (filters.mine && filters.currentUserId) ||
      (!elevated && filters.currentUserId);
    if (restrictToMine) {
      and.push({
        OR: [
          { managerId: filters.currentUserId },
          { chinaManagerId: filters.currentUserId },
        ],
      });
    }
    // Фильтр по менеджеру (любой роли — TJ или CN).
    if (filters.managerUserId) {
      and.push({
        OR: [
          { managerId: filters.managerUserId },
          { chinaManagerId: filters.managerUserId },
        ],
      });
    }
    if (filters.search) {
      and.push({
        OR: [
          { fullName: { contains: filters.search, mode: 'insensitive' } },
          { email: { contains: filters.search, mode: 'insensitive' } },
          { phones: { has: filters.search } },
        ],
      });
    }
    if (and.length) where.AND = and;
    return this.prisma.student.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: STUDENT_INCLUDE,
    });
  }

  async findOne(id: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      include: { ...STUDENT_INCLUDE, applications: true },
    });
    if (!student) throw new NotFoundException('Студент не найден');
    return student;
  }

  /**
   * История оплат конкретного студента (для CRM-карточки, ТЗ §3.3).
   * Возвращает все INCOME-транзакции + payment-заявки (PENDING/CONFIRMED/...)
   */
  async paymentsHistory(studentId: string) {
    const [transactions, paymentRequests] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { studentId, type: 'INCOME' },
        orderBy: { date: 'desc' },
        select: {
          id: true,
          amount: true,
          currency: true,
          category: true,
          date: true,
          comment: true,
          recordedBy: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: { studentId },
        orderBy: { createdAt: 'desc' },
        include: { confirmedBy: { select: { id: true, fullName: true } } },
      }),
    ]);
    const totalPaid = transactions.reduce((s, t) => s + t.amount, 0);
    return { transactions, paymentRequests, totalPaid };
  }

  async update(id: string, dto: UpdateStudentDto, user: CurrentUser) {
    const existing = await this.findOne(id);
    this.ensureCanEdit(existing, user);

    const data: Prisma.StudentUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.phones !== undefined) data.phones = dto.phones;
    if (dto.phoneLabels !== undefined) data.phoneLabels = dto.phoneLabels;
    if (dto.preferredChannel !== undefined) data.preferredChannel = dto.preferredChannel;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.photoUrl !== undefined) data.photoUrl = dto.photoUrl;
    if (dto.comment !== undefined) data.comment = dto.comment;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.direction !== undefined) {
      data.direction = dto.direction;
      if (dto.cabinet === undefined) {
        data.cabinet = CABINET_BY_DIRECTION[dto.direction];
      }
    }
    if (dto.cabinet !== undefined) data.cabinet = dto.cabinet;

    const updated = await this.prisma.student.update({
      where: { id },
      data,
      include: STUDENT_INCLUDE,
    });
    this.realtime.emitStudentAndStaff(id, 'student:updated', { studentId: id });

    // Логируем и уведомляем staff о каждом изменённом поле
    const FIELD_LABELS: Record<string, string> = {
      fullName: 'ФИО',
      phones: 'Телефоны',
      email: 'Email',
      direction: 'Направление',
      cabinet: 'Кабинет',
      status: 'Статус',
      comment: 'Комментарий',
      photoUrl: 'Фото',
    };
    const changes: string[] = [];
    for (const k of Object.keys(FIELD_LABELS)) {
      const before = (existing as any)[k];
      const after = (updated as any)[k];
      const beforeS = Array.isArray(before) ? before.join(', ') : (before ?? '—');
      const afterS = Array.isArray(after) ? after.join(', ') : (after ?? '—');
      if (String(beforeS) !== String(afterS)) {
        changes.push(`${FIELD_LABELS[k]}: ${beforeS} → ${afterS}`);
      }
    }
    if (changes.length > 0) {
      const summary = changes.join('; ');
      this.activity?.log?.({
        actorId: user.id,
        actorRole: user.role,
        action: 'STUDENT_UPDATE',
        studentId: id,
        studentName: updated.fullName,
        details: summary,
      }).catch(() => undefined);
      this.notifications?.notifyAllStaff?.({
        type: 'STUDENT_UPDATE',
        title: 'Изменения у студента',
        message: `${updated.fullName}: ${summary}`,
        payload: { studentId: id },
      }).catch(() => undefined);
    }

    return updated;
  }

  /** Сохраняет анкету студента из CRM (admin / manager). */
  async updateForm(id: string, form: any, user: CurrentUser) {
    const existing = await this.findOne(id);
    this.ensureCanEdit(existing, user);
    const updated = await this.prisma.student.update({
      where: { id },
      data: { applicationForm: form },
      include: STUDENT_INCLUDE,
    });
    this.realtime.emitStudentAndStaff(id, 'form:updated', { studentId: id });
    this.realtime.emitStudentAndStaff(id, 'student:updated', { studentId: id });
    this.activity?.log?.({
      actorId: user.id,
      actorRole: user.role,
      action: 'STUDENT_UPDATE',
      studentId: id,
      studentName: updated.fullName,
      details: 'Изменена анкета студента',
    }).catch(() => undefined);
    return updated;
  }

  async assignManager(
    id: string,
    patch: { managerId?: string | null; chinaManagerId?: string | null },
    user: CurrentUser,
  ) {
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Только администратор может переназначать менеджеров');
    }
    await this.findOne(id);

    const data: any = {};
    if (patch.managerId !== undefined) {
      if (patch.managerId) {
        const exists = await this.prisma.user.findUnique({ where: { id: patch.managerId } });
        if (!exists) throw new NotFoundException('Локальный менеджер не найден');
      }
      data.managerId = patch.managerId;
    }
    if (patch.chinaManagerId !== undefined) {
      if (patch.chinaManagerId) {
        const exists = await this.prisma.user.findUnique({ where: { id: patch.chinaManagerId } });
        if (!exists) throw new NotFoundException('Китайский менеджер не найден');
      }
      data.chinaManagerId = patch.chinaManagerId;
    }

    // Синхронизируем на связанных заявках
    if (Object.keys(data).length > 0) {
      await this.prisma.application.updateMany({ where: { studentId: id }, data });
    }
    const updated = await this.prisma.student.update({
      where: { id },
      data,
      include: STUDENT_INCLUDE,
    });
    this.realtime.emitStudentAndStaff(id, 'student:updated', { studentId: id });
    this.realtime.emitStaff('application:updated', { studentId: id });
    return updated;
  }

  async remove(id: string, user: CurrentUser) {
    // QA-fix: удаление студента — только ADMIN.
    // Раньше любой EMPLOYEE мог удалить студента без назначенного менеджера.
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Удалять студентов может только администратор');
    }
    await this.findOne(id); // проверяем существование (бросит NotFoundException если нет)
    // Заявки сохраняем как историю — Prisma автоматически делает SetNull для
    // optional FK Application.studentId. Document/Enrollment/LessonProgress/
    // Interaction/Payment каскадятся через onDelete: Cascade в схеме.
    await this.prisma.student.delete({ where: { id } });
    this.realtime.emitStaff('student:deleted', { studentId: id });
    return { ok: true };
  }

  async addDocument(
    studentId: string,
    file: { filename: string; originalname: string; mimetype: string; size: number; url: string },
    type: string = 'OTHER',
    user?: CurrentUser,
  ) {
    const existing = await this.findOne(studentId);
    if (user) this.ensureCanEdit(existing, user);
    // Раньше на каждый тип хранили только один документ — теперь разрешаем
    // несколько файлов в одной категории (студент может загрузить, например,
    // паспорт + копию + перевод в одну плитку «Загран паспорт»).
    const doc = await this.prisma.document.create({
      data: {
        studentId,
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: file.url,
        type,
      },
    });
    this.realtime.emitStudentAndStaff(studentId, 'document:uploaded', { studentId, doc });
    this.realtime.emitStudentAndStaff(studentId, 'student:updated', { studentId });
    return doc;
  }

  async removeDocument(documentId: string, user: CurrentUser) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { student: { select: { managerId: true } } },
    });
    if (!doc) throw new NotFoundException('Документ не найден');
    if (doc.student) this.ensureCanEdit(doc.student, user);
    await this.prisma.document.delete({ where: { id: documentId } });
    const studentId = (doc as any).studentId;
    if (studentId) {
      this.realtime.emitStudentAndStaff(studentId, 'document:deleted', { studentId, docId: documentId });
      this.realtime.emitStudentAndStaff(studentId, 'student:updated', { studentId });
    }
    return { ok: true };
  }

  async stats(user?: { id: string; role: Role; roles?: Role[] }) {
    // Менеджеры видят только своих. Elevated (FOUNDER/ADMIN/ACCOUNTANT) — всех.
    const where: Prisma.StudentWhereInput | undefined =
      user && !isElevated(user)
        ? { OR: [{ managerId: user.id }, { chinaManagerId: user.id }] }
        : undefined;
    const [total, byCabinet, byDirection, byStatus] = await Promise.all([
      this.prisma.student.count({ where }),
      this.prisma.student.groupBy({
        by: ['cabinet'],
        _count: true,
        orderBy: { cabinet: 'asc' },
        where,
      }),
      this.prisma.student.groupBy({ by: ['direction'], _count: true, where }),
      // ТЗ §4 «Активные клиенты» — нужен срез по StudentStatus
      this.prisma.student.groupBy({ by: ['status'], _count: true, where }),
    ]);
    return { total, byCabinet, byDirection, byStatus };
  }
}
