import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClassMaterialKind, ClassSessionStatus, Direction, Prisma, StudyGroupStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { promises as fsp } from 'fs';
import { basename, join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { canSeeAllStudents } from '../auth/client-access';
import { DEFAULT_CABINET } from '../common/cabinets';
import { secureRandomString } from '../common/random';
import { parseCalendarDateUtc, tjLocalDay } from '../common/tj-time';
import { utf8Name } from '../common/upload-name';
import {
  assertAcademyManager,
  assertCanRunGroup,
  canMarkSession,
  canRunGroup,
  isAcademyManager,
  teachesGroup,
  type AcademyViewer,
} from './academy-access';
import {
  academyStatusOf,
  buildJournal,
  isWeekKey,
  needsDecision,
  rowsOf,
  summarize,
  weekKeyOf,
  type AcademyStatus,
  type JournalWeek,
  type WeekStudentResult,
  weeklyPattern,
} from './journal-math';
import {
  AcademyDecisionDto,
  AddMaterialLinkDto,
  CreateAcademyStudentDto,
  GiveFlagDto,
  ReinstateDto,
  RemoveFlagDto,
  SaveJournalEntriesDto,
  SaveJournalWeeksDto,
  UpdateAcademyStudentDto,
} from './dto/academy.dto';

/** Папка файлов уроков внутри uploads (раздаётся тем же /uploads). */
export const ACADEMY_UPLOAD_SUBDIR = 'academy';

export function uploadsRoot(): string {
  return resolve(process.cwd(), process.env.UPLOADS_DIR || './uploads');
}

const USER_REF = { select: { id: true, fullName: true, isActive: true } } as const;

const SESSION_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  topic: true,
  teacherId: true,
} as const;

/** Сколько последних комментариев учителей показывать в карточке ученика. */
const RECENT_COMMENTS = 15;
/** Потолок списка учеников за один запрос — предохранитель. */
const STUDENTS_TAKE_LIMIT = 3000;

function generatePassword(length = 8): string {
  return secureRandomString('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', length);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Полных лет на сегодня по Душанбе; null — даты нет. */
function ageOf(birthday: Date | null): number | null {
  if (!birthday) return null;
  const today = tjLocalDay();
  const [ty, tm, td] = today.split('-').map(Number);
  const b = birthday.toISOString().slice(0, 10);
  const [by, bm, bd] = b.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age >= 0 && age < 130 ? age : null;
}

type MembershipRow = {
  groupId: string;
  studentId: string;
  joinedAt: Date;
  leftAt: Date | null;
};

@Injectable()
export class AcademyService {
  private readonly logger = new Logger(AcademyService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ─────────────────────────────── ЖУРНАЛ ─────────────────────────────────

  /**
   * Журнал группы: недели, уроки, отметки, итоги, сводка по ученикам.
   * Смотрят руководство, учитель группы и подменный учитель её занятий
   * (последний отмечает только свои уроки — canEditLessons на фронте).
   */
  async getJournal(user: AcademyViewer, groupId: string) {
    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, status: true, teacherId: true, teacher: USER_REF },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    const canEditAll = canRunGroup(user, group);
    if (!canEditAll) {
      const substitute = user
        ? await this.prisma.classSession.count({ where: { groupId, teacherId: user.id } })
        : 0;
      if (!substitute) throw new ForbiddenException('Это не ваша группа');
    }

    const [sessions, members, entries, weeks] = await Promise.all([
      this.prisma.classSession.findMany({ where: { groupId }, select: SESSION_SELECT, orderBy: { startsAt: 'asc' } }),
      this.prisma.groupMember.findMany({
        where: { groupId },
        select: {
          studentId: true,
          joinedAt: true,
          leftAt: true,
          leftReason: true,
          student: { select: { id: true, fullName: true, photoUrl: true, academyExpelledAt: true } },
        },
      }),
      this.prisma.journalEntry.findMany({
        where: { session: { groupId } },
        select: { sessionId: true, studentId: true, present: true, score: true, comment: true },
      }),
      this.prisma.journalWeek.findMany({
        where: { groupId },
        select: { studentId: true, weekStart: true, bonus: true, exam: true },
      }),
    ]);

    const flagCounts = await this.activeFlagCounts(members.map((m) => m.studentId));
    const built = buildJournal({ sessions, members, entries, weeks });

    const students = members
      .map((m) => ({
        id: m.studentId,
        fullName: m.student.fullName,
        photoUrl: m.student.photoUrl,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        leftReason: m.leftReason,
        active: !m.leftAt,
        expelled: !!m.student.academyExpelledAt,
        flags: flagCounts.get(m.studentId) ?? 0,
        summary: summarize(rowsOf(built, m.studentId)),
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName, 'ru'));

    return {
      group,
      canEditAll,
      canManage: isAcademyManager(user),
      currentWeek: weekKeyOf(new Date()),
      students,
      weeks: built,
    };
  }

  /**
   * Отметки за урок (пакетом): посещение, оценка 1–5, комментарий.
   * undefined — не трогать, null — стереть. Оценка ставится только
   * присутствующему: «не был» стирает оценку, оценка без отметки ставит «был».
   */
  async saveEntries(user: AcademyViewer, dto: SaveJournalEntriesDto) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: dto.sessionId },
      select: {
        id: true,
        groupId: true,
        status: true,
        startsAt: true,
        teacherId: true,
        group: { select: { teacherId: true } },
      },
    });
    if (!session) throw new NotFoundException('Занятие не найдено');
    if (!canMarkSession(user, session)) throw new ForbiddenException('Это не ваш урок');
    if (session.status === ClassSessionStatus.CANCELLED) {
      throw new BadRequestException('Занятие отменено — отметки не ставятся');
    }
    // Отмечать можно урок сегодняшнего дня и прошедшие: учитель отмечает на
    // самом уроке, а не за неделю вперёд.
    if (tjLocalDay(session.startsAt) > tjLocalDay()) {
      throw new BadRequestException('Урок ещё не наступил — отметки ставятся в день урока');
    }

    const ids = Array.from(new Set(dto.items.map((i) => i.studentId)));
    const members = await this.prisma.groupMember.findMany({
      where: { groupId: session.groupId, studentId: { in: ids } },
      select: { studentId: true },
    });
    if (members.length !== ids.length) throw new BadRequestException('Ученик не состоит в этой группе');

    const existing = await this.prisma.journalEntry.findMany({
      where: { sessionId: session.id, studentId: { in: ids } },
      select: { studentId: true, present: true, score: true, comment: true },
    });
    const byStudent = new Map(existing.map((e) => [e.studentId, e]));
    const updatedById = user?.id ?? null;

    const saved = await this.prisma.$transaction(
      dto.items.map((item) => {
        const prev = byStudent.get(item.studentId);
        let present = prev?.present ?? null;
        let score = prev?.score ?? null;
        let comment = prev?.comment ?? null;
        if (item.present !== undefined) present = item.present;
        if (item.score !== undefined) score = item.score;
        if (item.comment !== undefined) comment = item.comment?.trim().slice(0, 500) || null;
        if (item.present === false) score = null;
        else if (score !== null) present = true;
        const data = { present, score, comment, updatedById };
        return this.prisma.journalEntry.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: item.studentId } },
          create: { sessionId: session.id, studentId: item.studentId, ...data },
          update: data,
          select: { studentId: true, present: true, score: true, comment: true },
        });
      }),
    );

    // Урок отмечен — значит состоялся.
    if (session.status === ClassSessionStatus.SCHEDULED && saved.some((e) => e.present !== null)) {
      await this.prisma.classSession.update({
        where: { id: session.id },
        data: { status: ClassSessionStatus.DONE },
      });
    }
    return { sessionId: session.id, entries: saved };
  }

  /** Конец недели: бонус 0–10, экзамен 0–70 (undefined — не трогать, null — стереть). */
  async saveWeeks(user: AcademyViewer, dto: SaveJournalWeeksDto) {
    if (!isWeekKey(dto.weekStart)) throw new BadRequestException('Неделя указана неверно');
    const group = await this.prisma.studyGroup.findUnique({
      where: { id: dto.groupId },
      select: { id: true, teacherId: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    assertCanRunGroup(user, group);

    const ids = Array.from(new Set(dto.items.map((i) => i.studentId)));
    const members = await this.prisma.groupMember.findMany({
      where: { groupId: group.id, studentId: { in: ids } },
      select: { studentId: true },
    });
    if (members.length !== ids.length) throw new BadRequestException('Ученик не состоит в этой группе');

    const existing = await this.prisma.journalWeek.findMany({
      where: { groupId: group.id, weekStart: dto.weekStart, studentId: { in: ids } },
      select: { studentId: true, bonus: true, exam: true },
    });
    const byStudent = new Map(existing.map((w) => [w.studentId, w]));
    const updatedById = user?.id ?? null;

    const saved = await this.prisma.$transaction(
      dto.items.map((item) => {
        const prev = byStudent.get(item.studentId);
        const bonus = item.bonus !== undefined ? item.bonus : prev?.bonus ?? null;
        const exam = item.exam !== undefined ? item.exam : prev?.exam ?? null;
        const data = { bonus, exam, updatedById };
        return this.prisma.journalWeek.upsert({
          where: {
            groupId_studentId_weekStart: { groupId: group.id, studentId: item.studentId, weekStart: dto.weekStart },
          },
          create: { groupId: group.id, studentId: item.studentId, weekStart: dto.weekStart, ...data },
          update: data,
          select: { studentId: true, weekStart: true, bonus: true, exam: true },
        });
      }),
    );
    return { groupId: group.id, weekStart: dto.weekStart, weeks: saved };
  }

  // ───────────────────────────── МАТЕРИАЛЫ УРОКА ───────────────────────────

  private async sessionForMaterials(user: AcademyViewer, sessionId: string) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      select: { id: true, teacherId: true, group: { select: { id: true, teacherId: true } } },
    });
    if (!session) throw new NotFoundException('Занятие не найдено');
    if (!canMarkSession(user, session)) throw new ForbiddenException('Это не ваш урок');
    return session;
  }

  async addFiles(user: AcademyViewer, sessionId: string, files: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException('Файл не выбран');
    try {
      await this.sessionForMaterials(user, sessionId);
    } catch (e) {
      // Файлы уже легли на диск — без прав они не нужны.
      await Promise.all(files.map((f) => fsp.unlink(f.path).catch(() => undefined)));
      throw e;
    }
    const createdById = user?.id ?? null;
    const rows = await this.prisma.$transaction(
      files.map((f) =>
        this.prisma.classMaterial.create({
          data: {
            sessionId,
            kind: ClassMaterialKind.FILE,
            title: (utf8Name(f.originalname) || f.filename).slice(0, 200),
            url: `/uploads/${ACADEMY_UPLOAD_SUBDIR}/${f.filename}`,
            size: f.size,
            mimeType: f.mimetype?.slice(0, 120) || null,
            createdById,
          },
        }),
      ),
    );
    return rows;
  }

  async addLink(user: AcademyViewer, sessionId: string, dto: AddMaterialLinkDto) {
    await this.sessionForMaterials(user, sessionId);
    const raw = dto.url.trim();
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new BadRequestException('Ссылка указана неверно');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('Ссылка должна начинаться с http:// или https://');
    }
    return this.prisma.classMaterial.create({
      data: {
        sessionId,
        kind: ClassMaterialKind.LINK,
        title: (dto.title?.trim() || url.hostname).slice(0, 200),
        url: url.toString(),
        createdById: user?.id ?? null,
      },
    });
  }

  async removeMaterial(user: AcademyViewer, materialId: string) {
    const m = await this.prisma.classMaterial.findUnique({
      where: { id: materialId },
      select: { id: true, kind: true, url: true, sessionId: true },
    });
    if (!m) throw new NotFoundException('Материал не найден');
    await this.sessionForMaterials(user, m.sessionId);
    await this.prisma.classMaterial.delete({ where: { id: m.id } });
    if (m.kind === ClassMaterialKind.FILE) {
      const path = this.materialPath(m.url);
      if (path) await fsp.unlink(path).catch(() => undefined);
    }
    return { ok: true };
  }

  /** Путь файла на диске по url вида /uploads/academy/<имя>; null — не наш файл. */
  materialPath(url: string): string | null {
    const prefix = `/uploads/${ACADEMY_UPLOAD_SUBDIR}/`;
    if (!url.startsWith(prefix)) return null;
    const name = basename(url.slice(prefix.length));
    if (!name || name !== url.slice(prefix.length)) return null;
    return join(uploadsRoot(), ACADEMY_UPLOAD_SUBDIR, name);
  }

  // ──────────────────────────────── УЧЕНИКИ ────────────────────────────────

  /**
   * Ученики академии: заведённые в академии + студенты агентства, которые
   * состоят или состояли в группах. Учитель видит только тех, кто учился в
   * его группах. Поиск — по ФИО, e-mail и цифрам телефона.
   */
  async listStudents(
    user: AcademyViewer,
    f: { search?: string; groupId?: string; teacherId?: string; status?: string; type?: string },
  ) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const manager = isAcademyManager(user);
    const and: Prisma.StudentWhereInput[] = [{ OR: [{ academyOnly: true }, { groupMemberships: { some: {} } }] }];
    if (!manager) and.push({ groupMemberships: { some: { group: { teacherId: user.id } } } });
    if (f.groupId) and.push({ groupMemberships: { some: { groupId: f.groupId } } });
    if (manager && f.teacherId) {
      and.push({ groupMemberships: { some: { leftAt: null, group: { teacherId: f.teacherId } } } });
    }
    if (f.type === 'ACADEMY') and.push({ academyOnly: true });
    else if (f.type === 'AGENCY') and.push({ academyOnly: false });

    const rows = await this.prisma.student.findMany({
      where: { AND: and },
      take: STUDENTS_TAKE_LIMIT,
      select: {
        id: true,
        fullName: true,
        phones: true,
        email: true,
        photoUrl: true,
        birthday: true,
        academyOnly: true,
        academyExpelledAt: true,
        academyFlagsReviewedAt: true,
        createdAt: true,
        groupMemberships: {
          select: {
            groupId: true,
            joinedAt: true,
            leftAt: true,
            group: { select: { id: true, name: true, status: true, teacherId: true, teacher: USER_REF } },
          },
        },
        redFlags: { where: { removedAt: null }, select: { createdAt: true } },
      },
    });

    const q = (f.search || '').trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const filtered = q
      ? rows.filter(
          (s) =>
            s.fullName.toLowerCase().includes(q) ||
            (s.email || '').toLowerCase().includes(q) ||
            (qDigits.length >= 3 && s.phones.some((p) => p.replace(/\D/g, '').includes(qDigits))),
        )
      : rows;

    const summaries = await this.summariesFor(
      filtered.flatMap((s) =>
        s.groupMemberships.map((m) => ({ groupId: m.groupId, studentId: s.id, joinedAt: m.joinedAt, leftAt: m.leftAt })),
      ),
    );

    const items = filtered.map((s) => {
      const activeGroups = s.groupMemberships.filter((m) => !m.leftAt);
      const status = academyStatusOf({
        academyExpelledAt: s.academyExpelledAt,
        academyFlagsReviewedAt: s.academyFlagsReviewedAt,
        activeFlagDates: s.redFlags.map((r) => r.createdAt),
        activeGroups: activeGroups.length,
      });
      return {
        id: s.id,
        fullName: s.fullName,
        phone: s.phones[0] || null,
        email: s.email,
        photoUrl: s.photoUrl,
        age: ageOf(s.birthday),
        academyOnly: s.academyOnly,
        createdAt: s.createdAt,
        status,
        flags: s.redFlags.length,
        groups: activeGroups.map((m) => ({
          id: m.group.id,
          name: m.group.name,
          status: m.group.status,
          teacher: m.group.teacher,
        })),
        summary: summarize(summaries.get(s.id) ?? []),
      };
    });

    const counts: Record<AcademyStatus | 'ALL', number> = { ALL: items.length, ACTIVE: 0, PENDING: 0, EXPELLED: 0, NO_GROUP: 0 };
    for (const it of items) counts[it.status]++;

    const byStatus = f.status && f.status in counts && f.status !== 'ALL' ? items.filter((i) => i.status === f.status) : items;
    byStatus.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    return { items: byStatus, counts };
  }

  /**
   * Итоги недель учеников по их группам (для сводок): одна выборка занятий,
   * отметок и недель на все группы, затем общая формула journal-math.
   */
  private async summariesFor(memberships: MembershipRow[]): Promise<Map<string, WeekStudentResult[]>> {
    const out = new Map<string, WeekStudentResult[]>();
    if (!memberships.length) return out;
    const groupIds = Array.from(new Set(memberships.map((m) => m.groupId)));
    const studentIds = Array.from(new Set(memberships.map((m) => m.studentId)));
    const [sessions, entries, weeks] = await Promise.all([
      this.prisma.classSession.findMany({
        where: { groupId: { in: groupIds } },
        select: { ...SESSION_SELECT, groupId: true },
      }),
      this.prisma.journalEntry.findMany({
        where: { studentId: { in: studentIds }, session: { groupId: { in: groupIds } } },
        select: { sessionId: true, studentId: true, present: true, score: true, comment: true },
      }),
      this.prisma.journalWeek.findMany({
        where: { studentId: { in: studentIds }, groupId: { in: groupIds } },
        select: { groupId: true, studentId: true, weekStart: true, bonus: true, exam: true },
      }),
    ]);
    for (const gid of groupIds) {
      const gSessions = sessions.filter((s) => s.groupId === gid);
      const sessionIds = new Set(gSessions.map((s) => s.id));
      const built = buildJournal({
        sessions: gSessions,
        members: memberships.filter((m) => m.groupId === gid),
        entries: entries.filter((e) => sessionIds.has(e.sessionId)),
        weeks: weeks.filter((w) => w.groupId === gid),
      });
      for (const w of built) {
        for (const r of w.rows) {
          const list = out.get(r.studentId);
          if (list) list.push(r);
          else out.set(r.studentId, [r]);
        }
      }
    }
    return out;
  }

  /**
   * Поиск для «Добавить в группу»: студенты агентства и ученики академии
   * по ФИО, e-mail или цифрам телефона. Отдельно от GET /students: тот —
   * агентский список (без учеников академии и по правам «Студенты»), а
   * руководству академии нужны все, кого можно посадить в группу.
   */
  async pickStudents(user: AcademyViewer, search: string, groupId?: string) {
    assertAcademyManager(user);
    const q = (search || '').trim();
    if (q.length < 2) return [];
    const digits = q.replace(/\D/g, '');
    const select = {
      id: true,
      fullName: true,
      phones: true,
      email: true,
      academyOnly: true,
      academyExpelledAt: true,
      groupMemberships: { where: { leftAt: null }, select: { groupId: true, group: { select: { name: true } } } },
    } as const;
    const byText = await this.prisma.student.findMany({
      where: {
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { fullName: 'asc' },
      take: 30,
      select,
    });
    let byPhone: typeof byText = [];
    if (digits.length >= 4) {
      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Student"
         WHERE EXISTS (
           SELECT 1 FROM unnest(phones) AS p
            WHERE regexp_replace(p, '[^0-9]', '', 'g') LIKE ${'%' + digits + '%'}
         )
         LIMIT 30`;
      if (ids.length) {
        byPhone = await this.prisma.student.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select });
      }
    }
    const seen = new Set<string>();
    return [...byText, ...byPhone]
      .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
      .slice(0, 30)
      .map((s) => ({
        id: s.id,
        fullName: s.fullName,
        phone: s.phones[0] || null,
        email: s.email,
        academyOnly: s.academyOnly,
        expelled: !!s.academyExpelledAt,
        inGroup: groupId ? s.groupMemberships.some((m) => m.groupId === groupId) : false,
        groups: s.groupMemberships.map((m) => m.group.name),
      }));
  }

  private async activeFlagCounts(studentIds: string[]): Promise<Map<string, number>> {
    if (!studentIds.length) return new Map();
    const rows = await this.prisma.redFlag.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, removedAt: null },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.studentId, r._count._all]));
  }

  /** Ученик академии с членствами и флагами — для карточки и проверок. */
  private async loadAcademyStudent(id: string) {
    return this.prisma.student.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        phones: true,
        email: true,
        birthday: true,
        photoUrl: true,
        comment: true,
        createdAt: true,
        academyOnly: true,
        academyExpelledAt: true,
        academyExpelNote: true,
        academyExpelledBy: USER_REF,
        academyFlagsReviewedAt: true,
        managerId: true,
        chinaManagerId: true,
        groupMemberships: {
          orderBy: { joinedAt: 'asc' },
          select: {
            id: true,
            groupId: true,
            joinedAt: true,
            leftAt: true,
            leftReason: true,
            group: { select: { id: true, name: true, status: true, teacherId: true, teacher: USER_REF } },
          },
        },
        redFlags: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            reason: true,
            createdAt: true,
            removedAt: true,
            removeReason: true,
            group: { select: { id: true, name: true } },
            givenBy: USER_REF,
            removedBy: USER_REF,
          },
        },
      },
    });
  }

  private isAcademyStudent(s: { academyOnly: boolean; groupMemberships: unknown[] }) {
    return s.academyOnly || s.groupMemberships.length > 0;
  }

  /** Руководство или учитель хотя бы одной группы ученика (в любое время). */
  private assertCanSeeStudent(
    user: AcademyViewer,
    s: { groupMemberships: Array<{ group: { teacherId: string | null } }> },
  ) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    if (isAcademyManager(user)) return;
    if (s.groupMemberships.some((m) => teachesGroup(user, m.group))) return;
    throw new ForbiddenException('Это не ваш ученик');
  }

  /** Карточка ученика академии: контакты, группы, итоги по неделям, флаги, комментарии. */
  async getStudent(user: AcademyViewer, id: string) {
    const s = await this.loadAcademyStudent(id);
    if (!s || !this.isAcademyStudent(s)) throw new NotFoundException('Ученик академии не найден');
    this.assertCanSeeStudent(user, s);

    const memberships = s.groupMemberships.map((m) => ({
      groupId: m.groupId,
      studentId: s.id,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt,
    }));
    const perGroup = await this.weeksByGroup(memberships);
    const allRows: WeekStudentResult[] = [];
    const groups = s.groupMemberships.map((m) => {
      const weeks = perGroup.get(m.groupId) ?? [];
      const rows = rowsOf(weeks, s.id);
      allRows.push(...rows);
      return {
        membershipId: m.id,
        group: m.group,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        leftReason: m.leftReason,
        active: !m.leftAt,
        summary: summarize(rows),
        weeks: weeks
          .map((w) => {
            const r = w.rows.find((x) => x.studentId === s.id);
            return r
              ? {
                  key: w.key,
                  index: w.index,
                  from: w.from,
                  to: w.to,
                  held: r.held,
                  attended: r.attended,
                  lessonPoints: r.lessonPoints,
                  bonus: r.bonus,
                  exam: r.exam,
                  total: r.total,
                  final: r.final,
                }
              : null;
          })
          .filter(Boolean),
      };
    });

    const comments = await this.prisma.journalEntry.findMany({
      where: { studentId: s.id, comment: { not: null } },
      orderBy: { session: { startsAt: 'desc' } },
      take: RECENT_COMMENTS,
      select: {
        comment: true,
        score: true,
        present: true,
        updatedBy: { select: { id: true, fullName: true } },
        session: { select: { id: true, startsAt: true, topic: true, group: { select: { id: true, name: true } } } },
      },
    });

    const activeFlags = s.redFlags.filter((f) => !f.removedAt);
    const activeGroups = s.groupMemberships.filter((m) => !m.leftAt);
    const status = academyStatusOf({
      academyExpelledAt: s.academyExpelledAt,
      academyFlagsReviewedAt: s.academyFlagsReviewedAt,
      activeFlagDates: activeFlags.map((f) => f.createdAt),
      activeGroups: activeGroups.length,
    });
    const manager = isAcademyManager(user);
    const myActiveGroups = activeGroups.filter((m) => manager || teachesGroup(user, m.group)).map((m) => m.group);

    return {
      id: s.id,
      fullName: s.fullName,
      phones: s.phones,
      email: s.email,
      birthday: s.birthday,
      age: ageOf(s.birthday),
      photoUrl: s.photoUrl,
      academyOnly: s.academyOnly,
      // Комментарий агентского студента — заметки менеджеров продаж, учителю
      // он ни к чему; у ученика академии это комментарий из её же формы.
      comment: s.academyOnly ? s.comment : null,
      createdAt: s.createdAt,
      status,
      flagsActive: activeFlags.length,
      expelled: s.academyExpelledAt
        ? { at: s.academyExpelledAt, note: s.academyExpelNote, by: s.academyExpelledBy }
        : null,
      flags: s.redFlags,
      groups,
      summary: summarize(allRows),
      comments: comments.map((c) => ({
        comment: c.comment,
        score: c.score,
        present: c.present,
        author: c.updatedBy,
        sessionId: c.session.id,
        date: c.session.startsAt,
        topic: c.session.topic,
        group: c.session.group,
      })),
      canManage: manager,
      canFlag: !s.academyExpelledAt && myActiveGroups.length > 0,
      flagGroups: myActiveGroups.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  /** Журнал каждой группы, урезанный до переданных членств. */
  private async weeksByGroup(memberships: MembershipRow[]): Promise<Map<string, JournalWeek[]>> {
    const out = new Map<string, JournalWeek[]>();
    const groupIds = Array.from(new Set(memberships.map((m) => m.groupId)));
    if (!groupIds.length) return out;
    const studentIds = Array.from(new Set(memberships.map((m) => m.studentId)));
    const [sessions, entries, weeks] = await Promise.all([
      this.prisma.classSession.findMany({
        where: { groupId: { in: groupIds } },
        select: { ...SESSION_SELECT, groupId: true },
      }),
      this.prisma.journalEntry.findMany({
        where: { studentId: { in: studentIds }, session: { groupId: { in: groupIds } } },
        select: { sessionId: true, studentId: true, present: true, score: true, comment: true },
      }),
      this.prisma.journalWeek.findMany({
        where: { studentId: { in: studentIds }, groupId: { in: groupIds } },
        select: { groupId: true, studentId: true, weekStart: true, bonus: true, exam: true },
      }),
    ]);
    for (const gid of groupIds) {
      const gSessions = sessions.filter((s) => s.groupId === gid);
      const ids = new Set(gSessions.map((s) => s.id));
      out.set(
        gid,
        buildJournal({
          sessions: gSessions,
          members: memberships.filter((m) => m.groupId === gid),
          entries: entries.filter((e) => ids.has(e.sessionId)),
          weeks: weeks.filter((w) => w.groupId === gid),
        }),
      );
    }
    return out;
  }

  private normalizeEmail(raw: string): string {
    const email = (raw || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new BadRequestException('E-mail указан неверно');
    return email;
  }

  private normalizePhone(raw: string): string {
    const phone = (raw || '').trim();
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) throw new BadRequestException('Телефон указан неверно');
    return phone;
  }

  private normalizeName(raw: string): string {
    const name = (raw || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2) throw new BadRequestException('ФИО слишком короткое');
    if (/[<>]/.test(name)) throw new BadRequestException('ФИО содержит недопустимые символы');
    return name.slice(0, 120);
  }

  private parseBirthday(raw?: string): Date | null {
    if (!raw) return null;
    const d = parseCalendarDateUtc(raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Дата рождения указана неверно');
    if (d.getTime() > Date.now()) throw new BadRequestException('Дата рождения в будущем');
    return d;
  }

  private async assertEmailFree(email: string, exceptStudentId?: string) {
    const [dupStudent, dupUser] = await Promise.all([
      this.prisma.student.findFirst({ where: { email, ...(exceptStudentId ? { NOT: { id: exceptStudentId } } : {}) }, select: { id: true } }),
      this.prisma.user.findUnique({ where: { email }, select: { id: true } }),
    ]);
    if (dupStudent) throw new BadRequestException('Студент с таким e-mail уже есть');
    if (dupUser) throw new BadRequestException('Этот e-mail уже занят сотрудником');
  }

  /**
   * Ученик только академии: без заявки, сделки и оплаты. Направление и
   * кабинет обязательны в схеме Student — ставим заглушки и помечаем
   * направление неподтверждённым (как у заявок с лендинга).
   */
  async createStudent(user: AcademyViewer, dto: CreateAcademyStudentDto) {
    assertAcademyManager(user);
    const fullName = this.normalizeName(dto.fullName);
    const phone = this.normalizePhone(dto.phone);
    const email = this.normalizeEmail(dto.email);
    const birthday = this.parseBirthday(dto.birthday);
    await this.assertEmailFree(email);
    if (dto.groupId) await this.assertActiveGroup(dto.groupId);

    const password = generatePassword(8);
    const student = await this.prisma.student.create({
      data: {
        fullName,
        phones: [phone],
        email,
        password: await bcrypt.hash(password, 10),
        birthday,
        comment: dto.comment?.trim().slice(0, 1000) || null,
        direction: Direction.BACHELOR,
        directionConfirmed: false,
        cabinet: DEFAULT_CABINET,
        academyOnly: true,
        ...(dto.groupId ? { groupMemberships: { create: { groupId: dto.groupId } } } : {}),
      },
      select: { id: true, fullName: true, email: true },
    });
    return { ...student, password };
  }

  /** Данные ученика академии. Агентского студента правят в его карточке CRM. */
  async updateStudent(user: AcademyViewer, id: string, dto: UpdateAcademyStudentDto) {
    assertAcademyManager(user);
    const s = await this.prisma.student.findUnique({ where: { id }, select: { id: true, academyOnly: true, phones: true } });
    if (!s) throw new NotFoundException('Ученик не найден');
    if (!s.academyOnly) throw new BadRequestException('Данные студента агентства меняются в его карточке CRM');
    const data: Prisma.StudentUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = this.normalizeName(dto.fullName);
    if (dto.phone !== undefined) data.phones = [this.normalizePhone(dto.phone), ...s.phones.slice(1)];
    if (dto.email !== undefined) {
      const email = this.normalizeEmail(dto.email);
      await this.assertEmailFree(email, id);
      data.email = email;
    }
    if (dto.birthday !== undefined) data.birthday = this.parseBirthday(dto.birthday);
    if (dto.comment !== undefined) data.comment = dto.comment.trim().slice(0, 1000) || null;
    await this.prisma.student.update({ where: { id }, data });
    return this.getStudent(user, id);
  }

  /** Новый пароль ученику академии (старые входы перестают работать). */
  async resetPassword(user: AcademyViewer, id: string) {
    assertAcademyManager(user);
    const s = await this.prisma.student.findUnique({ where: { id }, select: { id: true, academyOnly: true, email: true } });
    if (!s) throw new NotFoundException('Ученик не найден');
    if (!s.academyOnly) throw new BadRequestException('Пароль студента агентства меняется в его карточке CRM');
    const password = generatePassword(8);
    await this.prisma.student.update({
      where: { id },
      data: { password: await bcrypt.hash(password, 10), tokenVersion: { increment: 1 } },
    });
    return { email: s.email, password };
  }

  private async assertActiveGroup(groupId: string) {
    const g = await this.prisma.studyGroup.findUnique({ where: { id: groupId }, select: { status: true } });
    if (!g) throw new NotFoundException('Группа не найдена');
    if (g.status !== StudyGroupStatus.ACTIVE) throw new BadRequestException('Группа в архиве');
  }

  // ───────────────────────────── КРАСНЫЕ ФЛАГИ ─────────────────────────────

  /**
   * Красный флаг — учитель своему ученику (в своей группе) или руководство.
   * Когда действующих флагов 3+ и среди них есть новый после последнего
   * «Оставить», руководству уходит уведомление «нужно решение».
   */
  async giveFlag(user: AcademyViewer, studentId: string, dto: GiveFlagDto) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const s = await this.loadAcademyStudent(studentId);
    if (!s || !this.isAcademyStudent(s)) throw new NotFoundException('Ученик академии не найден');
    if (s.academyExpelledAt) throw new BadRequestException('Ученик уже отчислен');
    const manager = isAcademyManager(user);
    const reason = dto.reason.trim().replace(/\s+/g, ' ');
    if (reason.length < 3) throw new BadRequestException('Напишите причину флага');

    const active = s.groupMemberships.filter((m) => !m.leftAt);
    let groupId: string | null = dto.groupId || null;
    if (groupId) {
      const m = active.find((x) => x.groupId === groupId);
      if (!m) throw new BadRequestException('Ученик не состоит в этой группе');
      if (!manager && !teachesGroup(user, m.group)) throw new ForbiddenException('Это не ваша группа');
    } else if (!manager) {
      const mine = active.filter((m) => teachesGroup(user, m.group));
      if (!mine.length) throw new ForbiddenException('Это не ваш ученик');
      groupId = mine[0].groupId;
    }

    const flag = await this.prisma.redFlag.create({
      data: { studentId, groupId, reason: reason.slice(0, 500), givenById: user.id },
      select: { id: true, reason: true, createdAt: true, group: { select: { id: true, name: true } } },
    });

    const activeFlagDates = [...s.redFlags.filter((f) => !f.removedAt).map((f) => f.createdAt), flag.createdAt];
    const decision = needsDecision({
      academyExpelledAt: null,
      academyFlagsReviewedAt: s.academyFlagsReviewedAt,
      activeFlagDates,
    });
    if (decision) {
      await this.notifications
        .notifyAudience('academy', [], {
          type: 'ACADEMY_FLAGS',
          title: '🚩 Нужно решение по ученику',
          message: `${s.fullName}: красных флагов — ${activeFlagDates.length}. Отчислить или оставить?`,
          payload: { studentId },
        })
        .catch((e) => this.logger.warn(`notify academy flags: ${e?.message || e}`));
    }
    return { flag, activeFlags: activeFlagDates.length, needsDecision: decision };
  }

  /** Снять ошибочный флаг — только руководство; в истории флаг остаётся. */
  async removeFlag(user: AcademyViewer, flagId: string, dto: RemoveFlagDto) {
    assertAcademyManager(user);
    const flag = await this.prisma.redFlag.findUnique({ where: { id: flagId }, select: { id: true, removedAt: true } });
    if (!flag) throw new NotFoundException('Флаг не найден');
    if (flag.removedAt) throw new BadRequestException('Флаг уже снят');
    await this.prisma.redFlag.update({
      where: { id: flagId },
      data: { removedAt: new Date(), removedById: user!.id, removeReason: dto.reason?.trim().slice(0, 500) || null },
    });
    return { ok: true };
  }

  /**
   * Решение руководства. EXPEL — отчислить (в любой момент, не только после
   * 3-го флага): ученик выходит из всех групп, оценки остаются. KEEP —
   * оставить: флаги до этого момента считаются рассмотренными.
   */
  async decide(user: AcademyViewer, studentId: string, dto: AcademyDecisionDto) {
    assertAcademyManager(user);
    const s = await this.loadAcademyStudent(studentId);
    if (!s || !this.isAcademyStudent(s)) throw new NotFoundException('Ученик академии не найден');
    if (s.academyExpelledAt) throw new BadRequestException('Ученик уже отчислен');
    const now = new Date();
    const note = dto.note?.trim().slice(0, 500) || null;

    if (dto.action === 'KEEP') {
      const pending = needsDecision({
        academyExpelledAt: null,
        academyFlagsReviewedAt: s.academyFlagsReviewedAt,
        activeFlagDates: s.redFlags.filter((f) => !f.removedAt).map((f) => f.createdAt),
      });
      if (!pending) throw new BadRequestException('Решение сейчас не требуется');
      await this.prisma.student.update({ where: { id: studentId }, data: { academyFlagsReviewedAt: now } });
      return this.getStudent(user, studentId);
    }

    const teacherIds = Array.from(
      new Set(s.groupMemberships.filter((m) => !m.leftAt && m.group.teacherId).map((m) => m.group.teacherId!)),
    );
    await this.prisma.$transaction([
      this.prisma.student.update({
        where: { id: studentId },
        data: { academyExpelledAt: now, academyExpelledById: user!.id, academyExpelNote: note },
      }),
      this.prisma.groupMember.updateMany({
        where: { studentId, leftAt: null },
        data: { leftAt: now, leftReason: 'EXPELLED' },
      }),
    ]);
    for (const tid of teacherIds) {
      await this.notifications
        .notifyUser(tid, {
          type: 'ACADEMY_EXPELLED',
          title: 'Ученик отчислен',
          message: `${s.fullName} отчислен(а) из академии${note ? `: ${note}` : ''}`,
          payload: { studentId },
        })
        .catch(() => undefined);
    }
    return this.getStudent(user, studentId);
  }

  /** Вернуть отчисленного; по желанию — сразу в группу. */
  async reinstate(user: AcademyViewer, studentId: string, dto: ReinstateDto) {
    assertAcademyManager(user);
    const s = await this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true, academyExpelledAt: true } });
    if (!s) throw new NotFoundException('Ученик не найден');
    if (!s.academyExpelledAt) throw new BadRequestException('Ученик не отчислен');
    if (dto.groupId) await this.assertActiveGroup(dto.groupId);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.student.update({
        where: { id: studentId },
        data: {
          academyExpelledAt: null,
          academyExpelledById: null,
          academyExpelNote: null,
          // Старые флаги рассмотрены этим решением; следующий снова спросит.
          academyFlagsReviewedAt: now,
        },
      }),
      ...(dto.groupId
        ? [
            this.prisma.groupMember.upsert({
              where: { groupId_studentId: { groupId: dto.groupId, studentId } },
              create: { groupId: dto.groupId, studentId },
              update: { leftAt: null, leftReason: null },
            }),
          ]
        : []),
    ]);
    return this.getStudent(user, studentId);
  }

  // ─────────────────────── БЛОК В КАРТОЧКЕ СТУДЕНТА CRM ─────────────────────

  /**
   * Короткая сводка академии для карточки студента агентства. Видят те же,
   * кто видит студента в CRM, плюс руководство академии и его учителя.
   */
  async crmSummary(user: AcademyViewer, studentId: string) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const s = await this.loadAcademyStudent(studentId);
    if (!s) throw new NotFoundException('Студент не найден');
    const allowed =
      isAcademyManager(user) ||
      canSeeAllStudents(user) ||
      s.managerId === user.id ||
      s.chinaManagerId === user.id ||
      s.groupMemberships.some((m) => teachesGroup(user, m.group));
    if (!allowed) throw new ForbiddenException('Нет доступа к этому студенту');
    if (!this.isAcademyStudent(s)) return { inAcademy: false as const };

    const perGroup = await this.weeksByGroup(
      s.groupMemberships.map((m) => ({ groupId: m.groupId, studentId: s.id, joinedAt: m.joinedAt, leftAt: m.leftAt })),
    );
    const rows = s.groupMemberships.flatMap((m) => rowsOf(perGroup.get(m.groupId) ?? [], s.id));
    const activeFlags = s.redFlags.filter((f) => !f.removedAt);
    const activeGroups = s.groupMemberships.filter((m) => !m.leftAt);
    return {
      inAcademy: true as const,
      status: academyStatusOf({
        academyExpelledAt: s.academyExpelledAt,
        academyFlagsReviewedAt: s.academyFlagsReviewedAt,
        activeFlagDates: activeFlags.map((f) => f.createdAt),
        activeGroups: activeGroups.length,
      }),
      flagsActive: activeFlags.length,
      groups: activeGroups.map((m) => ({ id: m.group.id, name: m.group.name, teacher: m.group.teacher })),
      summary: summarize(rows),
    };
  }

  // ──────────────────────────── КАБИНЕТ СТУДЕНТА ───────────────────────────

  /** Главная вкладки «Академия»: статус, группы, флаги, сводка. */
  async cabinetOverview(studentId: string) {
    const s = await this.loadAcademyStudent(studentId);
    if (!s) throw new NotFoundException('Студент не найден');
    if (!this.isAcademyStudent(s)) return { hasAcademy: false as const, academyOnly: false };

    const perGroup = await this.weeksByGroup(
      s.groupMemberships.map((m) => ({ groupId: m.groupId, studentId: s.id, joinedAt: m.joinedAt, leftAt: m.leftAt })),
    );
    const rows = s.groupMemberships.flatMap((m) => rowsOf(perGroup.get(m.groupId) ?? [], s.id));
    const activeFlags = s.redFlags.filter((f) => !f.removedAt);
    const active = s.groupMemberships.filter((m) => !m.leftAt);

    // Ближайшее занятие и «по каким дням» — по ближайшим неделям расписания.
    const now = new Date();
    const horizon = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
    const upcoming = active.length
      ? await this.prisma.classSession.findMany({
          where: {
            groupId: { in: active.map((m) => m.groupId) },
            status: { not: ClassSessionStatus.CANCELLED },
            endsAt: { gte: now },
            startsAt: { lte: horizon },
          },
          orderBy: { startsAt: 'asc' },
          select: { groupId: true, startsAt: true, endsAt: true, topic: true },
        })
      : [];

    return {
      hasAcademy: true as const,
      academyOnly: s.academyOnly,
      fullName: s.fullName,
      status: academyStatusOf({
        academyExpelledAt: s.academyExpelledAt,
        academyFlagsReviewedAt: s.academyFlagsReviewedAt,
        activeFlagDates: activeFlags.map((f) => f.createdAt),
        activeGroups: active.length,
      }),
      expelled: s.academyExpelledAt ? { at: s.academyExpelledAt, note: s.academyExpelNote } : null,
      flags: activeFlags.map((f) => ({ id: f.id, reason: f.reason, createdAt: f.createdAt, group: f.group })),
      groups: active.map((m) => {
        const mine = upcoming.filter((u) => u.groupId === m.groupId);
        return {
          id: m.group.id,
          name: m.group.name,
          status: m.group.status,
          teacher: m.group.teacher ? { fullName: m.group.teacher.fullName } : null,
          joinedAt: m.joinedAt,
          nextLesson: mine[0] ?? null,
          pattern: weeklyPattern(mine),
        };
      }),
      summary: summarize(rows),
    };
  }

  /**
   * Расписание: ближайшие занятия и недавние прошедшие (действующие группы).
   * ДЗ и материалы урока ученик видит с его начала — учитель может готовить
   * урок заранее, — поэтому у ещё не начавшихся занятий они скрыты.
   */
  async cabinetLessons(studentId: string) {
    const groupIds = await this.activeGroupIds(studentId);
    if (!groupIds.length) return { upcoming: [], past: [] };
    const now = new Date();
    const select = {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      topic: true,
      homework: true,
      homeworkDue: true,
      group: { select: { id: true, name: true, teacher: { select: { fullName: true } } } },
      teacher: { select: { fullName: true } },
      _count: { select: { materials: true } },
    } as const;
    const [upcomingRaw, past] = await Promise.all([
      this.prisma.classSession.findMany({
        where: { groupId: { in: groupIds }, endsAt: { gte: now } },
        orderBy: { startsAt: 'asc' },
        take: 40,
        select,
      }),
      this.prisma.classSession.findMany({
        where: { groupId: { in: groupIds }, endsAt: { lt: now }, status: { not: ClassSessionStatus.CANCELLED } },
        orderBy: { startsAt: 'desc' },
        take: 20,
        select,
      }),
    ]);
    const upcoming = upcomingRaw.map((s) =>
      s.startsAt.getTime() > now.getTime()
        ? { ...s, homework: null, homeworkDue: null, _count: { materials: 0 } }
        : s,
    );
    return { upcoming, past };
  }

  /** ДЗ и материалы начавшихся уроков действующих групп — новые сверху. */
  async cabinetHomework(studentId: string) {
    const groupIds = await this.activeGroupIds(studentId);
    if (!groupIds.length) return [];
    return this.prisma.classSession.findMany({
      where: {
        groupId: { in: groupIds },
        status: { not: ClassSessionStatus.CANCELLED },
        startsAt: { lte: new Date() },
        OR: [{ homework: { not: null } }, { materials: { some: {} } }, { topic: { not: null } }],
      },
      orderBy: { startsAt: 'desc' },
      take: 100,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        topic: true,
        homework: true,
        homeworkDue: true,
        group: { select: { id: true, name: true } },
        materials: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, kind: true, title: true, url: true, size: true, mimeType: true },
        },
      },
    }).then((rows) =>
      rows
        .filter((r) => r.homework || r.materials.length)
        .map((r) => ({
          ...r,
          // Адрес файла ученику не нужен (он закрыт для студентов) — только
          // id для скачивания; ссылки отдаём как есть.
          materials: r.materials.map((m) => ({ ...m, url: m.kind === ClassMaterialKind.LINK ? m.url : null })),
        })),
    );
  }

  /** Успеваемость по каждой группе: недели, свои отметки, итоги, среднее группы по неделям. */
  async cabinetProgress(studentId: string) {
    const memberships = await this.prisma.groupMember.findMany({
      where: { studentId },
      orderBy: { joinedAt: 'asc' },
      select: {
        groupId: true,
        joinedAt: true,
        leftAt: true,
        group: { select: { id: true, name: true, teacher: { select: { fullName: true } } } },
      },
    });
    if (!memberships.length) return [];
    const groupIds = memberships.map((m) => m.groupId);

    // Среднее по группе за неделю — по всем ученикам группы (без имён).
    const allMembers = await this.prisma.groupMember.findMany({
      where: { groupId: { in: groupIds } },
      select: { groupId: true, studentId: true, joinedAt: true, leftAt: true },
    });
    const [sessions, entries, weeks] = await Promise.all([
      this.prisma.classSession.findMany({
        where: { groupId: { in: groupIds } },
        select: { ...SESSION_SELECT, groupId: true },
      }),
      this.prisma.journalEntry.findMany({
        where: { session: { groupId: { in: groupIds } } },
        select: { sessionId: true, studentId: true, present: true, score: true, comment: true },
      }),
      this.prisma.journalWeek.findMany({
        where: { groupId: { in: groupIds } },
        select: { groupId: true, studentId: true, weekStart: true, bonus: true, exam: true },
      }),
    ]);

    return memberships.map((m) => {
      const gSessions = sessions.filter((s) => s.groupId === m.groupId);
      const ids = new Set(gSessions.map((s) => s.id));
      const built = buildJournal({
        sessions: gSessions,
        members: allMembers.filter((x) => x.groupId === m.groupId),
        entries: entries.filter((e) => ids.has(e.sessionId)),
        weeks: weeks.filter((w) => w.groupId === m.groupId),
      });
      const mine = rowsOf(built, studentId);
      return {
        group: m.group,
        active: !m.leftAt,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        summary: summarize(mine),
        weeks: built
          .map((w) => {
            const r = w.rows.find((x) => x.studentId === studentId);
            if (!r) return null;
            const finals = w.rows.filter((x) => x.final).map((x) => x.total);
            return {
              key: w.key,
              index: w.index,
              from: w.from,
              to: w.to,
              lessons: w.lessons.map((l) => ({
                id: l.id,
                startsAt: l.startsAt,
                topic: l.topic,
                past: l.past,
                mark: r.entries[l.id] ?? null,
              })),
              held: r.held,
              attended: r.attended,
              lessonPoints: r.lessonPoints,
              bonus: r.bonus,
              exam: r.exam,
              total: r.total,
              final: r.final,
              groupAvg: finals.length ? Math.round(finals.reduce((a, b) => a + b, 0) / finals.length) : null,
            };
          })
          .filter(Boolean),
      };
    });
  }

  /** Файл урока для ученика: только если он состоит или состоял в группе. */
  async cabinetMaterial(studentId: string, materialId: string) {
    const m = await this.prisma.classMaterial.findUnique({
      where: { id: materialId },
      select: {
        id: true,
        kind: true,
        title: true,
        url: true,
        mimeType: true,
        session: { select: { groupId: true, startsAt: true } },
      },
    });
    if (!m || m.kind !== ClassMaterialKind.FILE) throw new NotFoundException('Файл не найден');
    // Материалы урока открываются ученику с его началом.
    if (m.session.startsAt.getTime() > Date.now()) throw new ForbiddenException('Урок ещё не начался');
    const member = await this.prisma.groupMember.findUnique({
      where: { groupId_studentId: { groupId: m.session.groupId, studentId } },
      select: { leftAt: true },
    });
    if (!member || member.leftAt) throw new ForbiddenException('Нет доступа к этому файлу');
    const path = this.materialPath(m.url);
    if (!path) throw new NotFoundException('Файл не найден');
    return { path, title: m.title, mimeType: m.mimeType };
  }

  private async activeGroupIds(studentId: string): Promise<string[]> {
    const rows = await this.prisma.groupMember.findMany({
      where: { studentId, leftAt: null },
      select: { groupId: true },
    });
    return rows.map((r) => r.groupId);
  }
}
