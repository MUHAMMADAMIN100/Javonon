import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClassSessionStatus, Prisma, StudyGroupStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { hasRole, isFounder, UserWithRoles } from '../auth/role-utils';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';
import {
  AddGroupMembersDto,
  CreateClassSessionDto,
  CreateStudyGroupDto,
  UpdateClassSessionDto,
  UpdateStudyGroupDto,
} from './dto/study-groups.dto';

/**
 * РАСПИСАНИЕ ЗАНЯТИЙ.
 *
 * Единственный путь к расписанию — ГРУППА. Индивидуальный студент = группа из
 * одного человека; параллельной «персональной» ветки нет и заводить её
 * нельзя, иначе календарь CRM, напоминания cron'а и кабинет студента
 * пришлось бы писать дважды и они бы разъехались.
 *
 * Кто что видит:
 *   - FOUNDER / ADMIN — все группы и все занятия;
 *   - преподаватель (User в StudyGroup.teacherId или подменный в
 *     ClassSession.teacherId) — свои группы: видит и ведёт расписание;
 *   - состав группы и назначение преподавателя меняет только руководство —
 *     иначе преподаватель мог бы переписать себе нагрузку;
 *   - студент (лендинг-кабинет) — только занятия групп, где он состоит.
 *
 * Напоминание перед занятием шлёт CronService через уже существующий
 * NotificationsService (sweepSessionReminders ниже). Второго канала
 * уведомлений не заводим.
 */

/**
 * За сколько до занятия уходит напоминание. Cron тикает чаще (каждые 30
 * минут), поэтому фактическое напоминание приходит в окне 1.5–2 часа до
 * начала — этого хватает, чтобы доехать, и не настолько рано, чтобы забыть.
 */
const SESSION_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000;

/** Потолок выборки календаря за один запрос — предохранитель от «выгрузить всё». */
const CALENDAR_TAKE_LIMIT = 2000;

/** Сколько ближайших занятий отдаём кабинету студента по умолчанию. */
const STUDENT_UPCOMING_DEFAULT = 20;

type Viewer = (UserWithRoles & { id: string }) | null | undefined;

@Injectable()
export class StudyGroupsService {
  private readonly logger = new Logger(StudyGroupsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ────────────────────────────── ГРУППЫ ──────────────────────────────────

  /**
   * Список групп. Руководство видит все, остальные — только те, где они
   * записаны преподавателем. Скоуп именно в `where`, а не фильтром после
   * выборки: иначе размер ответа выдавал бы существование чужих групп.
   */
  async listGroups(
    user: Viewer,
    opts: { status?: StudyGroupStatus; teacherId?: string; programId?: string; search?: string } = {},
  ) {
    const where: Prisma.StudyGroupWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.programId) where.programId = opts.programId;
    if (opts.search) where.name = { contains: opts.search, mode: 'insensitive' };
    if (!this.isElevatedViewer(user)) {
      where.teacherId = user?.id ?? '__none__';
    } else if (opts.teacherId) {
      where.teacherId = opts.teacherId;
    }

    return this.prisma.studyGroup.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        program: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
        _count: { select: { members: true, sessions: true } },
      },
    });
  }

  /** Карточка группы: состав + ближайшие занятия. */
  async getGroup(user: Viewer, id: string) {
    const group = await this.prisma.studyGroup.findUnique({
      where: { id },
      include: {
        program: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
        members: {
          orderBy: { joinedAt: 'asc' },
          include: {
            student: {
              select: { id: true, fullName: true, phones: true, email: true, status: true },
            },
          },
        },
        sessions: {
          orderBy: { startsAt: 'asc' },
          take: 200,
          include: { teacher: { select: { id: true, fullName: true } } },
        },
      },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    this.assertCanSeeGroup(user, group.teacherId);
    return group;
  }

  async createGroup(user: Viewer, dto: CreateStudyGroupDto) {
    this.assertCanAdminGroups(user);
    const name = dto.name.trim();
    if (name.length < 2) throw new BadRequestException('Название группы слишком короткое');

    await this.assertProgramExists(dto.programId);
    await this.assertTeacherExists(dto.teacherId);
    const studentIds = await this.validateStudentIds(dto.studentIds ?? []);

    return this.prisma.studyGroup.create({
      data: {
        name,
        programId: dto.programId || null,
        teacherId: dto.teacherId || null,
        description: dto.description?.trim().slice(0, 1000) || null,
        members: studentIds.length
          ? { create: studentIds.map((studentId) => ({ studentId })) }
          : undefined,
      },
      include: {
        program: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
        _count: { select: { members: true, sessions: true } },
      },
    });
  }

  async updateGroup(user: Viewer, id: string, dto: UpdateStudyGroupDto) {
    this.assertCanAdminGroups(user);
    const group = await this.prisma.studyGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');

    const data: Prisma.StudyGroupUpdateInput = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.length < 2) throw new BadRequestException('Название группы слишком короткое');
      data.name = name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description.trim().slice(0, 1000) || null;
    }
    if (dto.status !== undefined) data.status = dto.status;
    // Пустая строка — осознанное «отвязать»: связь nullable, а отдельного
    // DELETE-эндпоинта под каждую ссылку заводить незачем.
    if (dto.programId !== undefined) {
      const pid = dto.programId.trim();
      if (pid) {
        await this.assertProgramExists(pid);
        data.program = { connect: { id: pid } };
      } else {
        data.program = { disconnect: true };
      }
    }
    if (dto.teacherId !== undefined) {
      const tid = dto.teacherId.trim();
      if (tid) {
        await this.assertTeacherExists(tid);
        data.teacher = { connect: { id: tid } };
      } else {
        data.teacher = { disconnect: true };
      }
    }

    return this.prisma.studyGroup.update({
      where: { id },
      data,
      include: {
        program: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
        _count: { select: { members: true, sessions: true } },
      },
    });
  }

  /**
   * Удаление группы. Каскадом уносит членство и ЗАНЯТИЯ (см. onDelete в
   * схеме) — поэтому для отучившихся групп правильный путь не сюда, а
   * `status: ARCHIVED`: история занятий остаётся.
   */
  async removeGroup(user: Viewer, id: string) {
    this.assertCanAdminGroups(user);
    const group = await this.prisma.studyGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    await this.prisma.studyGroup.delete({ where: { id } });
    return { ok: true };
  }

  // ───────────────────────────── СОСТАВ ГРУППЫ ────────────────────────────

  async addMembers(user: Viewer, groupId: string, dto: AddGroupMembersDto) {
    this.assertCanAdminGroups(user);
    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');

    const studentIds = await this.validateStudentIds(dto.studentIds);
    if (studentIds.length === 0) throw new BadRequestException('Не выбран ни один студент');

    // skipDuplicates вместо предварительной проверки: @@unique([groupId,
    // studentId]) и так не даст задвоить, а повторное нажатие «Добавить» не
    // должно падать 500-й ошибкой.
    await this.prisma.groupMember.createMany({
      data: studentIds.map((studentId) => ({ groupId, studentId })),
      skipDuplicates: true,
    });
    return this.getGroup(user, groupId);
  }

  async removeMember(user: Viewer, groupId: string, studentId: string) {
    this.assertCanAdminGroups(user);
    // deleteMany, а не delete: удаление уже удалённого не должно быть 500-й.
    // Занятия группы при этом не трогаем — исключённый студент просто
    // перестаёт их видеть в кабинете.
    await this.prisma.groupMember.deleteMany({ where: { groupId, studentId } });
    return this.getGroup(user, groupId);
  }

  // ─────────────────────────────── ЗАНЯТИЯ ────────────────────────────────

  /**
   * Лента занятий для календаря CRM. Границы периода приходят как
   * `YYYY-MM-DD` из пикера и раскрываются в душанбинские сутки
   * (tjParseLocalDate / tjParseLocalDateEnd) — с сырым `new Date('...')`
   * последние 5 часов каждого дня уезжали бы в соседний.
   */
  async listSessions(
    user: Viewer,
    opts: { from?: string; to?: string; groupId?: string; teacherId?: string } = {},
  ) {
    const where: Prisma.ClassSessionWhereInput = {};
    if (opts.groupId) where.groupId = opts.groupId;
    if (opts.from || opts.to) {
      const range: Prisma.DateTimeFilter = {};
      if (opts.from) {
        const from = tjParseLocalDate(opts.from);
        if (isNaN(from.getTime())) throw new BadRequestException('from: некорректная дата');
        range.gte = from;
      }
      if (opts.to) {
        const to = tjParseLocalDateEnd(opts.to);
        if (isNaN(to.getTime())) throw new BadRequestException('to: некорректная дата');
        range.lte = to;
      }
      where.startsAt = range;
    }
    if (!this.isElevatedViewer(user)) {
      // Не-руководство видит только своё расписание: занятия своих групп плюс
      // те, где он поставлен подменным преподавателем.
      where.OR = [
        { group: { teacherId: user?.id ?? '__none__' } },
        { teacherId: user?.id ?? '__none__' },
      ];
    } else if (opts.teacherId) {
      where.OR = [{ group: { teacherId: opts.teacherId } }, { teacherId: opts.teacherId }];
    }

    return this.prisma.classSession.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: CALENDAR_TAKE_LIMIT,
      include: {
        group: {
          select: {
            id: true,
            name: true,
            teacherId: true,
            program: { select: { id: true, name: true } },
            _count: { select: { members: true } },
          },
        },
        teacher: { select: { id: true, fullName: true } },
      },
    });
  }

  async createSession(user: Viewer, groupId: string, dto: CreateClassSessionDto) {
    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: { id: true, teacherId: true, status: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    this.assertCanManageSessions(user, group.teacherId);
    if (group.status === StudyGroupStatus.ARCHIVED) {
      throw new BadRequestException('Группа в архиве — новые занятия не добавляются');
    }

    const { startsAt, endsAt } = this.parseSessionWindow(dto.startsAt, dto.endsAt);
    await this.assertTeacherExists(dto.teacherId);

    return this.prisma.classSession.create({
      data: {
        groupId,
        startsAt,
        endsAt,
        topic: dto.topic?.trim().slice(0, 200) || null,
        teacherId: dto.teacherId?.trim() || null,
      },
      include: {
        group: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
      },
    });
  }

  async updateSession(user: Viewer, sessionId: string, dto: UpdateClassSessionDto) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { group: { select: { teacherId: true } } },
    });
    if (!session) throw new NotFoundException('Занятие не найдено');
    this.assertCanManageSessions(user, session.group.teacherId);

    const data: Prisma.ClassSessionUpdateInput = {};
    if (dto.startsAt !== undefined || dto.endsAt !== undefined) {
      const { startsAt, endsAt } = this.parseSessionWindow(
        dto.startsAt ?? session.startsAt.toISOString(),
        dto.endsAt ?? session.endsAt.toISOString(),
      );
      data.startsAt = startsAt;
      data.endsAt = endsAt;
      // Перенос занятия обнуляет отметку напоминания: клиент обязан получить
      // сигнал про НОВОЕ время. Без этого перенесённое занятие оставалось бы
      // со штампом от прошлого расписания и молчало.
      //
      // НО только при ФАКТИЧЕСКОМ сдвиге окна, а не при наличии полей в теле:
      // ClassSessionModal шлёт startsAt/endsAt КАЖДЫЙ раз — даже когда менеджер
      // правит одну только тему или статус. Слепое обнуление снова взводило бы
      // уже отправленное напоминание, и ближайший тик sweepSessionReminders прислал
      // бы преподавателю второе — то есть рушилась бы гарантия "ровно один раз",
      // ради которой там сделан захват через UPDATE ... WHERE reminderSentAt IS NULL.
      // Сравнение по getTime() точное: fallback-ветка выше прогоняет сохранённый
      // Date через toISOString() → tjParseLocalDate(), а тот для строки с явным Z
      // возвращает тот же момент без сдвига.
      const windowMoved =
        startsAt.getTime() !== session.startsAt.getTime() ||
        endsAt.getTime() !== session.endsAt.getTime();
      if (windowMoved) data.reminderSentAt = null;
    }
    if (dto.topic !== undefined) data.topic = dto.topic.trim().slice(0, 200) || null;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.teacherId !== undefined) {
      const tid = dto.teacherId.trim();
      if (tid) {
        await this.assertTeacherExists(tid);
        data.teacher = { connect: { id: tid } };
      } else {
        data.teacher = { disconnect: true };
      }
    }

    return this.prisma.classSession.update({
      where: { id: sessionId },
      data,
      include: {
        group: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
      },
    });
  }

  async removeSession(user: Viewer, sessionId: string) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { group: { select: { teacherId: true } } },
    });
    if (!session) throw new NotFoundException('Занятие не найдено');
    this.assertCanManageSessions(user, session.group.teacherId);
    await this.prisma.classSession.delete({ where: { id: sessionId } });
    return { ok: true };
  }

  // ──────────────────── НАПОМИНАНИЯ ПЕРЕД ЗАНЯТИЕМ (CRON) ─────────────────

  /**
   * Напоминание преподавателю о ближайшем занятии.
   *
   * КАНАЛ — уже существующий NotificationsService, тот же, которым cron
   * шлёт напоминания по задачам и дедлайнам. Второго пути уведомлений в
   * системе нет и заводить его не нужно. Notification.userId ссылается на
   * User, то есть модель адресует только сотрудников — у студента канал
   * другой: он видит своё расписание в кабинете (GET /student-schedule).
   *
   * ИДЕМПОТЕНТНОСТЬ — на колонке `reminderSentAt`, проставляемой ТЕМ ЖЕ
   * запросом, который отбирает строки (`UPDATE ... WHERE reminderSentAt IS
   * NULL ... RETURNING id`). Поэтому:
   *   - повторный тик cron'а не находит уже отмеченные занятия и молчит;
   *   - рестарт пода между тиками ничего не дублирует — отметка durable;
   *   - две реплики делят строки атомарно, одна строка не достанется обеим.
   * Уведомления строятся ПО РЕЗУЛЬТАТУ захвата, а не по предварительному
   * SELECT'у: одинаковый SELECT у двух реплик дал бы преподавателю дубль.
   */
  async sweepSessionReminders(): Promise<{ reminded: number }> {
    const now = new Date();
    const horizon = new Date(now.getTime() + SESSION_REMINDER_LEAD_MS);

    // Prisma не умеет RETURNING в updateMany — отсюда raw. "updatedAt"
    // проставляем руками: @updatedAt применяется клиентом Prisma и в сыром
    // SQL не срабатывает.
    //
    // Границы окна — ISO-строкой с явным CAST в `timestamp`, а не Date'ом:
    // колонка у Prisma без таймзоны и хранит UTC-стенные часы, а связанный
    // как `timestamptz` параметр заставил бы Postgres приводить колонку по
    // TimeZone сессии и сдвинул бы окно. Подробнее — тот же приём и то же
    // объяснение в InstallmentsService.sweepOverdueStages.
    const nowSql = now.toISOString();
    const horizonSql = horizon.toISOString();
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "ClassSession"
         SET "reminderSentAt" = NOW(), "updatedAt" = NOW()
       WHERE status = 'SCHEDULED'::"ClassSessionStatus"
         AND "reminderSentAt" IS NULL
         AND "startsAt" >= CAST(${nowSql} AS timestamp)
         AND "startsAt" <= CAST(${horizonSql} AS timestamp)
      RETURNING id
    `;
    if (claimed.length === 0) return { reminded: 0 };

    const sessions = await this.prisma.classSession.findMany({
      where: { id: { in: claimed.map((r) => r.id) } },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        startsAt: true,
        topic: true,
        teacherId: true,
        group: {
          select: { id: true, name: true, teacherId: true, _count: { select: { members: true } } },
        },
      },
    });

    let reminded = 0;
    for (const s of sessions) {
      // Подменный преподаватель занятия важнее штатного преподавателя группы:
      // ведёт именно он, ему и напоминание.
      const recipientId = s.teacherId || s.group.teacherId;
      const when = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Asia/Dushanbe',
        hour: '2-digit',
        minute: '2-digit',
      }).format(s.startsAt);
      const message =
        `«${s.group.name}» в ${when} (студентов: ${s.group._count.members})` +
        (s.topic ? ` — тема: ${s.topic}` : '');
      const payload = { sessionId: s.id, groupId: s.group.id, startsAt: s.startsAt };

      if (recipientId) {
        await this.notifications.notifyUser(recipientId, {
          type: 'CLASS_SESSION_SOON',
          title: '📚 Скоро занятие',
          message,
          payload,
        });
      } else {
        // Преподавателя не назначили (или уволили — связь SetNull). Занятие
        // без ведущего — это то, что руководство обязано увидеть заранее.
        await this.notifications.notifyAdmins({
          type: 'CLASS_SESSION_NO_TEACHER',
          title: '⚠️ Скоро занятие без преподавателя',
          message,
          payload,
        });
      }
      reminded++;
    }
    this.logger.log(`Cron: classSessionReminders — напоминаний отправлено: ${reminded}`);
    return { reminded };
  }

  // ──────────────────── КАБИНЕТ СТУДЕНТА (лендинг) ────────────────────────

  /**
   * Ближайшие занятия студента. Скоуп — членство в группах (GroupMember);
   * никакого параметра «чьё расписание» тут нет и быть не может, id берётся
   * из студенческого токена.
   *
   * Отменённые занятия скрыты: студенту важно, куда идти, а не история
   * правок. Прошедшие тоже — отдельная вкладка «история» не заказана.
   */
  async listUpcomingForStudent(studentId: string, limit?: number) {
    const take = Math.min(Math.max(limit ?? STUDENT_UPCOMING_DEFAULT, 1), 100);
    const sessions = await this.prisma.classSession.findMany({
      where: {
        status: ClassSessionStatus.SCHEDULED,
        endsAt: { gte: new Date() },
        group: { members: { some: { studentId } } },
      },
      orderBy: { startsAt: 'asc' },
      take,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        topic: true,
        status: true,
        group: {
          select: { id: true, name: true, program: { select: { id: true, name: true } } },
        },
        teacher: { select: { id: true, fullName: true } },
      },
    });
    return sessions;
  }

  /** Занятия студента за период — для месячной сетки в кабинете. */
  async listRangeForStudent(studentId: string, from?: string, to?: string) {
    const where: Prisma.ClassSessionWhereInput = {
      status: { not: ClassSessionStatus.CANCELLED },
      group: { members: { some: { studentId } } },
    };
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) {
        const d = tjParseLocalDate(from);
        if (isNaN(d.getTime())) throw new BadRequestException('from: некорректная дата');
        range.gte = d;
      }
      if (to) {
        const d = tjParseLocalDateEnd(to);
        if (isNaN(d.getTime())) throw new BadRequestException('to: некорректная дата');
        range.lte = d;
      }
      where.startsAt = range;
    }
    return this.prisma.classSession.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: CALENDAR_TAKE_LIMIT,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        topic: true,
        status: true,
        group: {
          select: { id: true, name: true, program: { select: { id: true, name: true } } },
        },
        teacher: { select: { id: true, fullName: true } },
      },
    });
  }

  // ─────────────────────────── ВСПОМОГАТЕЛЬНОЕ ────────────────────────────

  /**
   * FOUNDER/ADMIN — «видят всё». ACCOUNTANT сюда не входит: расписание это
   * не финансовая поверхность, а состав групп — персональные данные
   * студентов.
   */
  private isElevatedViewer(user: Viewer): boolean {
    return !!user && (isFounder(user) || hasRole(user, 'ADMIN'));
  }

  private assertCanSeeGroup(user: Viewer, teacherId: string | null) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    if (this.isElevatedViewer(user)) return;
    if (teacherId && teacherId === user.id) return;
    throw new ForbiddenException('Это не ваша группа');
  }

  /** Состав, преподаватель, создание и удаление групп — только руководство. */
  private assertCanAdminGroups(user: Viewer) {
    if (!this.isElevatedViewer(user)) {
      throw new ForbiddenException('Управлять группами может только руководство');
    }
  }

  /** Расписание своей группы ведёт и её преподаватель. */
  private assertCanManageSessions(user: Viewer, groupTeacherId: string | null) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    if (this.isElevatedViewer(user)) return;
    if (groupTeacherId && groupTeacherId === user.id) return;
    throw new ForbiddenException('Это не ваша группа');
  }

  /**
   * Разбор границ занятия. Наивную строку `2026-08-20T14:30` из
   * `<input type="datetime-local">` tjParseLocalDate трактует как душанбинское
   * время, а не UTC — иначе всё расписание съезжало бы на 5 часов.
   */
  private parseSessionWindow(startRaw: string, endRaw: string) {
    const startsAt = tjParseLocalDate(startRaw);
    const endsAt = tjParseLocalDate(endRaw);
    if (isNaN(startsAt.getTime())) throw new BadRequestException('Некорректное начало занятия');
    if (isNaN(endsAt.getTime())) throw new BadRequestException('Некорректный конец занятия');
    if (endsAt <= startsAt) {
      throw new BadRequestException('Конец занятия должен быть позже начала');
    }
    return { startsAt, endsAt };
  }

  /** FK-ошибка Prisma дала бы бесполезную 500 — проверяем заранее. */
  private async assertProgramExists(programId?: string | null) {
    const id = programId?.trim();
    if (!id) return;
    const found = await this.prisma.program.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('Программа не найдена');
  }

  private async assertTeacherExists(teacherId?: string | null) {
    const id = teacherId?.trim();
    if (!id) return;
    const found = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('Сотрудник-преподаватель не найден');
  }

  /** Отсеиваем несуществующих студентов до вставки — по той же причине. */
  private async validateStudentIds(ids: string[]): Promise<string[]> {
    const unique = Array.from(new Set(ids.map((s) => s.trim()).filter(Boolean)));
    if (unique.length === 0) return [];
    const found = await this.prisma.student.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new NotFoundException('Часть студентов не найдена');
    }
    return found.map((s) => s.id);
  }
}
