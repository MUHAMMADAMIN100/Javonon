import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClassMaterialKind, ClassSessionStatus, Prisma, StudyGroupStatus } from '@prisma/client';
import { promises as fsp } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UserWithRoles } from '../auth/role-utils';
import { parseCalendarDateUtc, tjLocalDay, tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';
import { canMarkSession, canRunGroup, isAcademyManager, teachesGroup } from '../academy/academy-access';
import { addDaysToKey, daysBetweenKeys, weeklyPattern } from '../academy/journal-math';
import { materialFilePath } from '../academy/academy.service';
import {
  AddGroupMembersDto,
  BulkClassSessionsDto,
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
 * Кто что видит (academy/academy-access.ts):
 *   - руководство академии (основатель, админ, роль с «Академия —
 *     управление») — все группы и все занятия;
 *   - учитель (StudyGroup.teacherId) — свои группы: расписание, уроки, ДЗ;
 *     подменный учитель (ClassSession.teacherId) — тему и ДЗ своего урока;
 *   - состав группы и назначение учителя меняет только руководство —
 *     иначе учитель мог бы переписать себе нагрузку;
 *   - студент (лендинг-кабинет) — только занятия групп, где он состоит
 *     сейчас (GroupMember.leftAt IS NULL).
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

/** Шаблон расписания: не больше года и не больше 300 занятий за раз. */
const BULK_MAX_DAYS = 366;
const BULK_MAX_SESSIONS = 300;

/** Действующий состав группы — вышедшие (leftAt) остаются только в журнале. */
const ACTIVE_MEMBER: Prisma.GroupMemberWhereInput = { leftAt: null };

/** Отметка в журнале, из-за которой занятие нельзя удалить (только отменить). */
const MARKED_ENTRY: Prisma.JournalEntryWhereInput = {
  OR: [
    { present: { not: null } },
    { score: { not: null } },
    { attendance: { not: null } },
    { homeworkPct: { not: null } },
    { vocabularyPct: { not: null } },
    { performancePct: { not: null } },
    { comment: { not: null } },
  ],
};

/** Срок ДЗ — не дальше стольких дней от урока (столько колонок в дневнике). */
const HOMEWORK_MAX_DAYS = 60;

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

    const groups = await this.prisma.studyGroup.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        program: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true, isActive: true } },
        _count: { select: { members: { where: ACTIVE_MEMBER }, sessions: true } },
      },
    });

    // Ближайшее занятие и «по каким дням» — одной выборкой на все группы
    // (4 недели вперёд), чтобы список не делал запрос на каждую карточку.
    const now = new Date();
    const upcoming = groups.length
      ? await this.prisma.classSession.findMany({
          where: {
            groupId: { in: groups.map((g) => g.id) },
            status: { not: ClassSessionStatus.CANCELLED },
            endsAt: { gte: now },
            startsAt: { lte: new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000) },
          },
          orderBy: { startsAt: 'asc' },
          select: { groupId: true, startsAt: true, endsAt: true, topic: true },
        })
      : [];
    return groups.map((g) => {
      const mine = upcoming.filter((s) => s.groupId === g.id);
      return { ...g, nextSession: mine[0] ?? null, pattern: weeklyPattern(mine) };
    });
  }

  /**
   * Карточка группы: состав (вместе с вышедшими — у них leftAt), занятия с
   * ДЗ и материалами. Открывают руководство, учитель группы и подменный
   * учитель её занятий; что из этого можно менять — в `access`.
   */
  async getGroup(user: Viewer, id: string) {
    const group = await this.prisma.studyGroup.findUnique({
      where: { id },
      include: {
        program: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true, isActive: true } },
        completedBy: { select: { id: true, fullName: true, isActive: true } },
        members: {
          orderBy: { joinedAt: 'asc' },
          include: {
            student: {
              select: {
                id: true,
                fullName: true,
                phones: true,
                email: true,
                status: true,
                photoUrl: true,
                academyOnly: true,
                academyExpelledAt: true,
                academyLevel: { select: { id: true, name: true } },
              },
            },
          },
        },
        sessions: {
          orderBy: { startsAt: 'asc' },
          take: 1000,
          include: {
            teacher: { select: { id: true, fullName: true, isActive: true } },
            materials: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, kind: true, title: true, url: true, size: true, mimeType: true, createdAt: true },
            },
            _count: { select: { journal: { where: MARKED_ENTRY }, homeworkLogs: true } },
          },
        },
      },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    await this.assertCanSeeGroup(user, group.id, group.teacherId);
    const run = canRunGroup(user, group);
    const active = group.status === StudyGroupStatus.ACTIVE;
    return {
      ...group,
      access: {
        manage: this.isElevatedViewer(user),
        run,
        // Учитель группы добавляет учеников сам (новых и из базы без группы).
        addStudents: run && active,
        // «Завершить курс»: учитель группы и руководство, пока группа идёт.
        complete: run && active && !group.completedAt,
      },
    };
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
        teacher: { select: { id: true, fullName: true, isActive: true } },
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
        teacher: { select: { id: true, fullName: true, isActive: true } },
        _count: { select: { members: true, sessions: true } },
      },
    });
  }

  /**
   * Что будет при удалении группы — окно «Удалить группу» в CRM показывает
   * это ДО удаления: сколько занятий и материалов уйдёт, сколько учеников
   * останется без группы и можно ли удалять вообще. Счёт тот же, что
   * проверяет removeGroup, — окно и сервер не разойдутся.
   */
  async removalPreview(user: Viewer, id: string) {
    this.assertCanAdminGroups(user);
    const group = await this.prisma.studyGroup.findUnique({
      where: { id },
      select: { id: true, name: true, status: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    return { ...group, ...(await this.removalCounts(id)) };
  }

  /**
   * Удаление группы. Каскадом уносит членство и ЗАНЯТИЯ с материалами (см.
   * onDelete в схеме) — поэтому для отучившихся групп правильный путь не
   * сюда, а `status: ARCHIVED`: история занятий остаётся.
   */
  async removeGroup(user: Viewer, id: string) {
    this.assertCanAdminGroups(user);
    const group = await this.prisma.studyGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    const counts = await this.removalCounts(id);
    // Оценки и итоги недель удалились бы каскадом — такую группу только в архив.
    if (counts.marks > 0) {
      throw new BadRequestException('В группе есть оценки — удалить нельзя, переведите её в архив');
    }
    if (counts.diary > 0) {
      throw new BadRequestException('Ученики вели дневник ДЗ — удалить нельзя, переведите группу в архив');
    }
    const files = await this.materialFiles({ session: { groupId: id } });
    await this.prisma.studyGroup.delete({ where: { id } });
    await this.unlinkFiles(files);
    return { ok: true };
  }

  /**
   * marks — отметки журнала и итоги недель старого журнала; members — кто
   * в группе сейчас (как «Учеников» в списке групп).
   */
  private async removalCounts(groupId: string) {
    const [sessions, members, materials, entries, weeks, diary] = await Promise.all([
      this.prisma.classSession.count({ where: { groupId } }),
      this.prisma.groupMember.count({ where: { groupId, ...ACTIVE_MEMBER } }),
      this.prisma.classMaterial.count({ where: { session: { groupId } } }),
      this.prisma.journalEntry.count({ where: { session: { groupId }, ...MARKED_ENTRY } }),
      this.prisma.journalWeek.count({ where: { groupId } }),
      this.prisma.homeworkLog.count({ where: { session: { groupId } } }),
    ]);
    const marks = entries + weeks;
    return { sessions, members, materials, marks, diary, canDelete: marks === 0 && diary === 0 };
  }

  /** Файлы уроков на диске: строки уходят каскадом, файлы — вручную, после удаления. */
  private async materialFiles(where: Prisma.ClassMaterialWhereInput) {
    const rows = await this.prisma.classMaterial.findMany({
      where: { ...where, kind: ClassMaterialKind.FILE },
      select: { url: true },
    });
    return rows.map((r) => materialFilePath(r.url)).filter((p): p is string => !!p);
  }

  private async unlinkFiles(paths: string[]) {
    await Promise.all(paths.map((p) => fsp.unlink(p).catch(() => undefined)));
  }

  // ───────────────────────────── СОСТАВ ГРУППЫ ────────────────────────────

  /**
   * Добавить в группу. Руководство — любых студентов агентства и учеников
   * академии. Учитель — в свою действующую группу и только учеников
   * академии, которые сейчас ни в одной группе: клиентов агентства и чужих
   * учеников он не видит и посадить к себе не может.
   */
  async addMembers(user: Viewer, groupId: string, dto: AddGroupMembersDto) {
    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: { id: true, teacherId: true, status: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    const manager = this.isElevatedViewer(user);
    if (!manager) {
      if (!user || !teachesGroup(user, group)) {
        throw new ForbiddenException('Управлять группами может только руководство');
      }
      if (group.status !== StudyGroupStatus.ACTIVE) throw new BadRequestException('Группа в архиве');
    }

    const studentIds = await this.validateStudentIds(dto.studentIds);
    if (studentIds.length === 0) throw new BadRequestException('Не выбран ни один студент');
    if (!manager) {
      const allowed = await this.prisma.student.count({
        where: {
          id: { in: studentIds },
          OR: [{ academyOnly: true }, { groupMemberships: { some: {} } }],
          groupMemberships: { none: { leftAt: null } },
        },
      });
      if (allowed !== studentIds.length) {
        throw new ForbiddenException('Учитель добавляет только учеников академии, которые сейчас без группы');
      }
    }
    const expelled = await this.prisma.student.findMany({
      where: { id: { in: studentIds }, academyExpelledAt: { not: null } },
      select: { fullName: true },
    });
    if (expelled.length) {
      throw new BadRequestException(
        `Отчислен из академии: ${expelled.map((s) => s.fullName).join(', ')} — сначала верните в академию`,
      );
    }

    // skipDuplicates вместо предварительной проверки: @@unique([groupId,
    // studentId]) и так не даст задвоить, а повторное нажатие «Добавить» не
    // должно падать 500-й ошибкой. Вышедших раньше возвращаем снятием leftAt —
    // их прошлые отметки в журнале остаются на месте.
    await this.prisma.$transaction([
      this.prisma.groupMember.updateMany({
        where: { groupId, studentId: { in: studentIds }, leftAt: { not: null } },
        data: { leftAt: null, leftReason: null },
      }),
      this.prisma.groupMember.createMany({
        data: studentIds.map((studentId) => ({ groupId, studentId })),
        skipDuplicates: true,
      }),
    ]);
    return this.getGroup(user, groupId);
  }

  async removeMember(user: Viewer, groupId: string, studentId: string) {
    this.assertCanAdminGroups(user);
    // Строку не удаляем, а закрываем (leftAt): журнал группы продолжает
    // показывать ученика за недели, когда он учился. updateMany — чтобы
    // повторное нажатие не было 500-й. Занятия группы ученик перестаёт
    // видеть в кабинете.
    await this.prisma.groupMember.updateMany({
      where: { groupId, studentId, leftAt: null },
      data: { leftAt: new Date(), leftReason: 'REMOVED' },
    });
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
            _count: { select: { members: { where: ACTIVE_MEMBER } } },
          },
        },
        teacher: { select: { id: true, fullName: true, isActive: true } },
        // Окно занятия из календаря показывает и материалы урока.
        materials: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, kind: true, title: true, url: true, size: true, mimeType: true, createdAt: true },
        },
        _count: { select: { journal: { where: MARKED_ENTRY } } },
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
        teacher: { select: { id: true, fullName: true, isActive: true } },
      },
    });
  }

  async updateSession(user: Viewer, sessionId: string, dto: UpdateClassSessionDto) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { group: { select: { teacherId: true } } },
    });
    if (!session) throw new NotFoundException('Занятие не найдено');
    // Время, статус и замену меняют учитель группы и руководство; тему и ДЗ
    // своего урока — ещё и подменный учитель.
    const touchesSchedule =
      dto.startsAt !== undefined || dto.endsAt !== undefined || dto.status !== undefined || dto.teacherId !== undefined;
    if (touchesSchedule) this.assertCanManageSessions(user, session.group.teacherId);
    else if (!canMarkSession(user, session)) throw new ForbiddenException('Это не ваш урок');

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
    if (dto.homework !== undefined || dto.homeworkDue !== undefined) {
      await this.applyHomework(session, dto, data);
    }
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
        teacher: { select: { id: true, fullName: true, isActive: true } },
      },
    });
  }

  /**
   * ДЗ урока и срок. С заданием срок обязателен: с дня урока по срок ученик
   * ведёт дневник ДЗ. Срок — не раньше дня урока и не дальше 60 дней.
   * Задание, по которому ученики уже пишут дневник, можно поправить, но не
   * стереть — иначе их записи остались бы без задания.
   */
  private async applyHomework(
    session: { id: string; startsAt: Date; homework: string | null; homeworkDue: Date | null },
    dto: UpdateClassSessionDto,
    data: Prisma.ClassSessionUpdateInput,
  ) {
    const homework =
      dto.homework !== undefined ? dto.homework.trim().slice(0, 4000) || null : session.homework;
    let due: Date | null = session.homeworkDue;
    if (dto.homeworkDue !== undefined) {
      const raw = dto.homeworkDue.trim();
      if (!raw) due = null;
      else {
        due = parseCalendarDateUtc(raw);
        if (Number.isNaN(due.getTime())) throw new BadRequestException('Срок ДЗ указан неверно');
      }
    }
    if (!homework) {
      if (session.homework) {
        const logs = await this.prisma.homeworkLog.count({ where: { sessionId: session.id } });
        if (logs > 0) {
          throw new BadRequestException('Ученики уже ведут дневник по этому ДЗ — задание можно изменить, но не удалить');
        }
      }
      data.homework = null;
      data.homeworkDue = null;
      data.homeworkSetAt = null;
      return;
    }
    // Задание появилось только сейчас — отсюда считаются дни дневника.
    if (!session.homework) data.homeworkSetAt = new Date();
    if (!due) throw new BadRequestException('Укажите срок сдачи ДЗ');
    const startsAt = (data.startsAt as Date | undefined) ?? session.startsAt;
    const lessonDay = tjLocalDay(startsAt);
    const dueDay = due.toISOString().slice(0, 10);
    if (dueDay < lessonDay) throw new BadRequestException('Срок сдачи не может быть раньше дня урока');
    if (daysBetweenKeys(lessonDay, dueDay) > HOMEWORK_MAX_DAYS) {
      throw new BadRequestException(`Срок сдачи — не дальше ${HOMEWORK_MAX_DAYS} дней от урока`);
    }
    data.homework = homework;
    data.homeworkDue = due;
  }

  async removeSession(user: Viewer, sessionId: string) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { group: { select: { teacherId: true } } },
    });
    if (!session) throw new NotFoundException('Занятие не найдено');
    this.assertCanManageSessions(user, session.group.teacherId);
    const marked = await this.prisma.journalEntry.count({ where: { sessionId, ...MARKED_ENTRY } });
    if (marked > 0) {
      throw new BadRequestException('По занятию есть отметки в журнале — его можно только отменить');
    }
    const diary = await this.prisma.homeworkLog.count({ where: { sessionId } });
    if (diary > 0) {
      throw new BadRequestException('По занятию ученики ведут дневник ДЗ — его можно только отменить');
    }
    const files = await this.materialFiles({ sessionId });
    await this.prisma.classSession.delete({ where: { id: sessionId } });
    await this.unlinkFiles(files);
    return { ok: true };
  }

  /**
   * Занятия по шаблону: каждый выбранный день недели между `from` и `to`
   * (включительно, по Душанбе) в одно и то же время. Занятие группы, уже
   * стоящее на это же время, пропускается — шаблон можно запускать повторно,
   * чтобы продлить курс. dryRun — только посчитать.
   */
  async bulkCreateSessions(user: Viewer, groupId: string, dto: BulkClassSessionsDto) {
    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: { id: true, teacherId: true, status: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    this.assertCanManageSessions(user, group.teacherId);
    if (group.status === StudyGroupStatus.ARCHIVED) {
      throw new BadRequestException('Группа в архиве — новые занятия не добавляются');
    }
    if (dto.endTime <= dto.startTime) throw new BadRequestException('Конец занятия должен быть позже начала');
    const fromDay = parseCalendarDateUtc(dto.from);
    const toDay = parseCalendarDateUtc(dto.to);
    if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) {
      throw new BadRequestException('Даты указаны неверно');
    }
    if (toDay < fromDay) throw new BadRequestException('Дата «по» раньше даты «с»');
    const days = Math.round((toDay.getTime() - fromDay.getTime()) / 86_400_000) + 1;
    if (days > BULK_MAX_DAYS) throw new BadRequestException('Не больше года за один раз');

    const weekdays = new Set(dto.weekdays);
    const slots: Array<{ startsAt: Date; endsAt: Date }> = [];
    for (let i = 0; i < days; i++) {
      const key = addDaysToKey(dto.from, i);
      const wd = ((new Date(`${key}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1; // 1 = Пн … 7 = Вс
      if (!weekdays.has(wd)) continue;
      slots.push({
        startsAt: tjParseLocalDate(`${key}T${dto.startTime}`),
        endsAt: tjParseLocalDate(`${key}T${dto.endTime}`),
      });
    }
    if (slots.length > BULK_MAX_SESSIONS) {
      throw new BadRequestException(`Слишком много занятий за раз (${slots.length}) — не больше ${BULK_MAX_SESSIONS}`);
    }

    const existing = slots.length
      ? await this.prisma.classSession.findMany({
          where: { groupId, startsAt: { in: slots.map((s) => s.startsAt) } },
          select: { startsAt: true },
        })
      : [];
    const taken = new Set(existing.map((e) => e.startsAt.getTime()));
    const fresh = slots.filter((s) => !taken.has(s.startsAt.getTime()));
    const skipped = slots.length - fresh.length;
    if (dto.dryRun) return { count: fresh.length, skipped };
    if (!fresh.length) return { created: 0, skipped };

    const topic = dto.topic?.trim().slice(0, 200) || null;
    const res = await this.prisma.classSession.createMany({
      data: fresh.map((s) => ({ groupId, startsAt: s.startsAt, endsAt: s.endsAt, topic })),
    });
    return { created: res.count, skipped };
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
          select: { id: true, name: true, teacherId: true, _count: { select: { members: { where: ACTIVE_MEMBER } } } },
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
        group: { members: { some: { studentId, leftAt: null } } },
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
        teacher: { select: { id: true, fullName: true, isActive: true } },
      },
    });
    return sessions;
  }

  /** Занятия студента за период — для месячной сетки в кабинете. */
  async listRangeForStudent(studentId: string, from?: string, to?: string) {
    const where: Prisma.ClassSessionWhereInput = {
      status: { not: ClassSessionStatus.CANCELLED },
      group: { members: { some: { studentId, leftAt: null } } },
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
        teacher: { select: { id: true, fullName: true, isActive: true } },
      },
    });
  }

  // ─────────────────────────── ВСПОМОГАТЕЛЬНОЕ ────────────────────────────

  /**
   * Руководство академии «видит всё» (academy-access.ts: основатель, админ,
   * роль с «Академия — управление»). ACCOUNTANT сюда не входит: расписание —
   * не финансовая поверхность, а состав групп — персональные данные
   * студентов.
   */
  private isElevatedViewer(user: Viewer): boolean {
    return isAcademyManager(user);
  }

  /** Руководство, учитель группы или подменный учитель хотя бы одного её занятия. */
  private async assertCanSeeGroup(user: Viewer, groupId: string, teacherId: string | null) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    if (this.isElevatedViewer(user)) return;
    if (teacherId && teacherId === user.id) return;
    const substitute = await this.prisma.classSession.count({ where: { groupId, teacherId: user.id } });
    if (substitute > 0) return;
    throw new ForbiddenException('Это не ваша группа');
  }

  /** Состав, преподаватель, создание и удаление групп — только руководство. */
  private assertCanAdminGroups(user: Viewer) {
    if (!this.isElevatedViewer(user)) {
      throw new ForbiddenException('Управлять группами может только руководство');
    }
  }

  /** Расписание своей группы ведёт и её учитель. */
  private assertCanManageSessions(user: Viewer, groupTeacherId: string | null) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    if (canRunGroup(user, { teacherId: groupTeacherId })) return;
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
    const found = await this.prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } });
    if (!found) throw new NotFoundException('Сотрудник-преподаватель не найден');
    if (!found.isActive) throw new BadRequestException('Преподаватель уволен');
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
