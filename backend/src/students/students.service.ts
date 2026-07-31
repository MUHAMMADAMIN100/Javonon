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
import { CABINET_BY_DIRECTION } from '../common/cabinets';
import { parseCalendarDateUtc } from '../common/tj-time';

/**
 * DOB из CRM → UTC-полночь. Раньше здесь стоял голый `new Date(b)`: для
 * «YYYY-MM-DD» он даёт ровно UTC-полночь, то есть верную конвенцию, но
 * ЛЮБОЙ другой формат уехал бы в таймзону процесса. Единый хелпер держит
 * конвенцию одинаковой с applications.service.ts (лендинг), иначе в колонке
 * Student.birthday снова заведётся смесь двух смещений и cron
 * birthdayGreetings начнёт поздравлять часть студентов на сутки раньше.
 * Невалидную дату не роняем 400-й — просто не пишем (поведение как было).
 */
function parseStudentBirthday(input: unknown): Date | null {
  if (!input) return null;
  const date = parseCalendarDateUtc(String(input));
  return Number.isNaN(date.getTime()) ? null : date;
}

function generatePassword(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

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
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT с мульти-роли) пропускаем.
    // Раньше primary `=== 'ADMIN'` не давало пройти FOUNDER и
    // secondary-ADMIN'ам (ТЗ §2).
    if (isElevated(user as any)) return;
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
        birthday: parseStudentBirthday((dto as any).birthday),
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

    // Автосоздаём связанную заявку со статусом NEW_LEAD, чтобы выбор статуса
    // был доступен сразу. Это нужно для студентов, заведённых вручную через CRM.
    const application = await this.prisma.application.create({
      data: {
        fullName: student.fullName,
        phone: student.phones[0] || '',
        email: student.email,
        direction: student.direction,
        // Переносим пометку со студента, а не полагаемся на @default(true).
        // Здесь она всегда true (direction обязателен в CreateStudentDto),
        // но копировать направление и НЕ копировать его статус — значит
        // заводить два расходящихся источника правды об одном и том же поле.
        directionConfirmed: student.directionConfirmed,
        comment: student.comment,
        status: 'NEW_LEAD',
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
   * новую со статусом NEW_LEAD. Используется для студентов, заведённых вручную
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
        // В отличие от create() выше, студент здесь СУЩЕСТВУЮЩИЙ и мог быть
        // заведён самозаписью без направления — тогда у него
        // directionConfirmed=false. Без переноса пометки плейсхолдер
        // «отмывался» бы: заявка получила бы @default(true) и попала
        // в срез дашборда «по направлениям» как настоящий ответ клиента.
        directionConfirmed: student.directionConfirmed,
        comment: student.comment,
        status: 'NEW_LEAD',
        studentId: id,
      },
    });
    this.realtime.emitStaff('application:new', { application: created });
    this.realtime.emitStudent(id, 'student:updated', { studentId: id });
    return created;
  }

  async regeneratePassword(id: string, user: CurrentUser) {
    // Elevated, не primary-ADMIN-only (ТЗ §2 multi-role).
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Сбрасывать пароль студента может только администрация');
    }
    const existing = await this.findOne(id);
    if (!existing.email) {
      throw new BadRequestException('У студента нет email — невозможно создать доступ');
    }
    const plainPassword = generatePassword(8);
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    // tokenVersion: { increment: 1 } — отзыв всех ранее выпущенных
    // JWT этого студента (sec audit fix: раньше старый токен жил 7д).
    await this.prisma.student.update({
      where: { id },
      data: {
        password: passwordHash,
        tokenVersion: { increment: 1 },
      },
    });
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
    // BUG #16 (HIGH): typeahead-пикеры передают limit, чтобы не тянуть
    // на сервер всю базу (1000+ студентов). Полный список — без limit.
    limit?: number;
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
    // BUG #16 (HIGH): typeahead-пикер (SubmissionForm и пр.) передаёт
    // limit, чтобы не тащить 1000+ студентов в браузер на каждый keystroke.
    // Жёсткий потолок — 200 на любой limit, чтобы исключить злоупотребления.
    const take =
      typeof filters.limit === 'number' && filters.limit > 0
        ? Math.min(filters.limit, 200)
        : undefined;
    return this.prisma.student.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: STUDENT_INCLUDE,
      ...(take ? { take } : {}),
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
    // Онбординг: по ТЗ ведёт CLIENT_MANAGER + elevated (FOUNDER/ADMIN/
    // ACCOUNTANT). SALES_MANAGER, даже будучи назначенным managerId, не
    // должен менять этап онбординга — это зона клиентского менеджера.
    if (dto.onboardingStage !== undefined) {
      const userAny = user as any;
      const canEditOnboarding =
        isElevated(userAny) ||
        userAny?.role === 'CLIENT_MANAGER' ||
        (userAny?.roles || []).includes('CLIENT_MANAGER');
      if (!canEditOnboarding) {
        throw new ForbiddenException('Онбординг ведёт клиентский менеджер');
      }
      data.onboardingStage = dto.onboardingStage;
    }
    if ((dto as any).birthday !== undefined) {
      data.birthday = parseStudentBirthday((dto as any).birthday);
    }
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.photoUrl !== undefined) data.photoUrl = dto.photoUrl;
    if (dto.comment !== undefined) data.comment = dto.comment;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.cabinet !== undefined) data.cabinet = dto.cabinet;
    if (dto.direction !== undefined) {
      data.direction = dto.direction;
      // Направление проставил живой человек — плейсхолдер, приехавший из
      // заявки с лендинга, больше не плейсхолдер.
      data.directionConfirmed = true;
      // Кабинет пересчитываем по направлению, когда менеджер его не выбирал:
      //   (A) cabinet вообще не прислан — прежнее поведение;
      //   (B) cabinet прислан, но не изменился, а студент до этого сидел
      //       в кабинете-«приёмнике» после конвертации заявки
      //       (directionConfirmed=false). Форма CRM шлёт cabinet ВСЕГДА —
      //       инпут просто прогружен старым значением, — поэтому без (B)
      //       конвертированный лид навсегда застревал бы в DEFAULT_CABINET,
      //       и кабинеты 2–6 не наполнялись бы новым потоком вообще.
      // Номер, который менеджер поменял руками в этом же запросе, не трогаем.
      const cabinetWasPlaceholder =
        (existing as any).directionConfirmed === false &&
        dto.cabinet === existing.cabinet;
      if (dto.cabinet === undefined || cabinetWasPlaceholder) {
        data.cabinet = CABINET_BY_DIRECTION[dto.direction];
      }
    }

    const updated = await this.prisma.student.update({
      where: { id },
      data,
      include: STUDENT_INCLUDE,
    });

    // Направление, проставленное менеджером здесь, — решение живого человека,
    // а не плейсхолдер, которым ApplicationsService заполняет NOT NULL-колонку
    // у заявок с лендинга. Прокидываем его в связанные заявки и снимаем
    // пометку directionConfirmed=false. Без этой синхронизации конвертированный
    // лид оставался бы «неподтверждённым» навсегда: после конвертации
    // направление правят именно в карточке студента, а срез дашборда
    // «по направлениям» и фильтр списка заявок его бы так и не увидели.
    if (dto.direction !== undefined) {
      await this.prisma.application
        .updateMany({
          where: { studentId: id },
          data: { direction: dto.direction, directionConfirmed: true },
        })
        .catch(() => undefined);
    }

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
    // Переназначение менеджеров — elevated (FOUNDER/ADMIN/ACCOUNTANT,
    // мульти-роли). Раньше primary `!== 'ADMIN'` блокировал FOUNDER
    // и secondary-ADMIN'а из ТЗ §2.
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Переназначать менеджеров может только администрация');
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
    // Удаление студента — elevated (FOUNDER/ADMIN/ACCOUNTANT). Раньше
    // проверка была `user.role !== 'ADMIN'` — primary-only, что:
    //   1) Блокировало FOUNDER (его role=FOUNDER, не ADMIN → 403).
    //   2) Игнорировало мульти-роли по ТЗ §2 (юзер с ADMIN в roles[]
    //      и другой primary не мог удалять, хотя должен).
    // isElevated() корректно учитывает оба случая.
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Удалять студентов может только администрация');
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
    // Audit trail — кто и когда загрузил какой документ (sec audit fix).
    if (user) {
      this.activity.log({
        actorId: user.id,
        actorRole: user.role || 'UNKNOWN',
        action: 'DOCUMENT_UPLOAD',
        studentId,
        studentName: existing.fullName,
        details: `Загружен ${type} · ${file.originalname}`,
        payload: { documentId: doc.id, type, size: file.size },
      }).catch(() => undefined);
    }
    return doc;
  }

  async removeDocument(documentId: string, user: CurrentUser) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { student: { select: { managerId: true, fullName: true } } },
    });
    if (!doc) throw new NotFoundException('Документ не найден');
    if (doc.student) this.ensureCanEdit(doc.student as any, user);
    await this.prisma.document.delete({ where: { id: documentId } });
    const studentId = (doc as any).studentId;
    if (studentId) {
      this.realtime.emitStudentAndStaff(studentId, 'document:deleted', { studentId, docId: documentId });
      this.realtime.emitStudentAndStaff(studentId, 'student:updated', { studentId });
      // Audit trail — кто и когда удалил какой документ (sec audit fix).
      this.activity.log({
        actorId: user.id,
        actorRole: user.role || 'UNKNOWN',
        action: 'DOCUMENT_DELETE',
        studentId,
        studentName: (doc as any).student?.fullName ?? null,
        details: `Удалён ${doc.type} · ${doc.originalName}`,
        payload: { documentId, type: doc.type, originalName: doc.originalName },
      }).catch(() => undefined);
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
