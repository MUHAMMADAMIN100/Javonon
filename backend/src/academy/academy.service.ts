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
import { parseCalendarDateUtc, tjLocalDay, tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';
import { utf8Name } from '../common/upload-name';
import {
  academyCan,
  academyGroupCan,
  assertAcademyCan,
  assertRoleHas,
  roleHas,
  canMarkSession,
  canRunGroup,
  isAcademyManager,
  teachesGroup,
  type AcademyViewer,
} from './academy-access';
import {
  academyStatusOf,
  attendanceOf,
  buildGroupJournal,
  diaryDays,
  diaryStart,
  groupWeekAverages,
  markOf,
  needsDecision,
  studentLessons,
  summarize,
  weekAverages,
  weeklyPattern,
  type AcademyStatus,
  type GroupJournal,
  type LessonMark,
} from './journal-math';
import {
  AcademyDecisionDto,
  AcademyLevelDto,
  AddMaterialLinkDto,
  CompleteCourseDto,
  CreateAcademyStudentDto,
  GiveFlagDto,
  HomeworkLogDto,
  ReinstateDto,
  RemoveFlagDto,
  ReorderLevelsDto,
  SaveJournalEntriesDto,
  UpdateAcademyStudentDto,
} from './dto/academy.dto';

/** Папка файлов уроков внутри uploads (раздаётся тем же /uploads). */
export const ACADEMY_UPLOAD_SUBDIR = 'academy';

export function uploadsRoot(): string {
  return resolve(process.cwd(), process.env.UPLOADS_DIR || './uploads');
}

/**
 * Путь файла урока на диске по url вида /uploads/academy/<имя>; null — не
 * наш файл. Им же чистит диск удаление группы и занятия (StudyGroupsService).
 */
export function materialFilePath(url: string): string | null {
  const prefix = `/uploads/${ACADEMY_UPLOAD_SUBDIR}/`;
  if (!url.startsWith(prefix)) return null;
  const name = basename(url.slice(prefix.length));
  if (!name || name !== url.slice(prefix.length)) return null;
  return join(uploadsRoot(), ACADEMY_UPLOAD_SUBDIR, name);
}

const USER_REF = { select: { id: true, fullName: true, isActive: true } } as const;
const LEVEL_REF = { select: { id: true, name: true } } as const;

const SESSION_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  topic: true,
  teacherId: true,
  homework: true,
} as const;

const ENTRY_SELECT = {
  sessionId: true,
  studentId: true,
  present: true,
  attendance: true,
  homeworkPct: true,
  vocabularyPct: true,
  performancePct: true,
  comment: true,
} as const;

/** Сколько последних комментариев учителей показывать в карточке ученика. */
const RECENT_COMMENTS = 15;
/** Сколько последних ДЗ с дневником показывать в карточке ученика. */
const RECENT_DIARIES = 20;
/** Потолок списка учеников за один запрос — предохранитель. */
const STUDENTS_TAKE_LIMIT = 3000;
/** «Из базы» у учителя: сколько учеников без группы показывать за раз. */
const TEACHER_PICK_LIMIT = 60;
/** Календарь кабинета: не больше двух месяцев за запрос. */
const CALENDAR_MAX_DAYS = 62;

/** Стандартный набор уровней — кнопка «Заполнить стандартными». */
export const DEFAULT_LEVELS = ['Beginner', 'Elementary', 'Pre-Intermediate', 'Intermediate', 'Upper-Intermediate', 'Advanced'];

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

/** «у 1 ученика», «у 3 учеников». */
function studentsGen(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? `${n} ученика` : `${n} учеников`;
}

// ─── Телефоны родителей ───
// Живут в общих Student.phones / phoneLabels — как в карточке CRM, где у
// номера есть подпись («сам», «Отец», «Мать»). Поиск по телефону и карточка
// студента видят их без отдельных колонок.
const OWN_LABEL = 'сам';
const FATHER_LABEL = 'Отец';
const MOTHER_LABEL = 'Мать';
const FATHER_RE = /^(отец|падар|father)$/i;
const MOTHER_RE = /^(мать|модар|mother)$/i;

export function parentPhonesOf(phones: string[], labels: string[]): { father: string | null; mother: string | null } {
  let father: string | null = null;
  let mother: string | null = null;
  phones.forEach((p, i) => {
    if (i === 0) return;
    const label = (labels[i] || '').trim();
    if (!father && FATHER_RE.test(label)) father = p;
    else if (!mother && MOTHER_RE.test(label)) mother = p;
  });
  return { father, mother };
}

/** Свой номер первым, прочие номера как были, затем отец и мать. */
function withParents(
  phones: string[],
  labels: string[],
  own: string,
  father: string | null,
  mother: string | null,
): { phones: string[]; phoneLabels: string[] } {
  const outPhones = [own];
  const outLabels = [(labels[0] || '').trim() || OWN_LABEL];
  phones.forEach((p, i) => {
    if (i === 0) return;
    const label = (labels[i] || '').trim();
    if (FATHER_RE.test(label) || MOTHER_RE.test(label)) return;
    outPhones.push(p);
    outLabels.push(labels[i] || '');
  });
  if (father) {
    outPhones.push(father);
    outLabels.push(FATHER_LABEL);
  }
  if (mother) {
    outPhones.push(mother);
    outLabels.push(MOTHER_LABEL);
  }
  return { phones: outPhones, phoneLabels: outLabels };
}

type MembershipRow = {
  groupId: string;
  studentId: string;
  joinedAt: Date;
  leftAt: Date | null;
};

/** Срок ДЗ хранится UTC-полночью календарного дня — это и есть 'YYYY-MM-DD'. */
const dueKey = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Map → объект для JSON. */
function mapToRecord<V>(m: Map<string, V>): Record<string, V> {
  return Object.fromEntries(m);
}

@Injectable()
export class AcademyService {
  private readonly logger = new Logger(AcademyService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ─────────────────────────────── ЖУРНАЛ ─────────────────────────────────

  /**
   * Журнал группы: уроки, листы уроков (кто на листе), отметки, сводка по
   * ученикам и средние по неделям для графика. Смотрят руководство, учитель
   * группы и подменный учитель её занятий (последний отмечает только свои
   * уроки — canEditAll на фронте).
   */
  async getJournal(user: AcademyViewer, groupId: string) {
    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, status: true, teacherId: true, teacher: USER_REF, completedAt: true },
    });
    if (!group) throw new NotFoundException('Группа не найдена');
    const canEditAll = canRunGroup(user, group);
    if (!canEditAll) {
      const substitute = user
        ? await this.prisma.classSession.count({ where: { groupId, teacherId: user.id } })
        : 0;
      if (!substitute) throw new ForbiddenException('Это не ваша группа');
    }

    const [sessions, members, entries] = await Promise.all([
      this.prisma.classSession.findMany({ where: { groupId }, select: SESSION_SELECT, orderBy: { startsAt: 'asc' } }),
      this.prisma.groupMember.findMany({
        where: { groupId },
        select: {
          studentId: true,
          joinedAt: true,
          leftAt: true,
          leftReason: true,
          student: {
            select: { id: true, fullName: true, photoUrl: true, academyExpelledAt: true, academyLevel: LEVEL_REF },
          },
        },
      }),
      this.prisma.journalEntry.findMany({ where: { session: { groupId } }, select: ENTRY_SELECT }),
    ]);

    const flagCounts = await this.activeFlagCounts(members.map((m) => m.studentId));
    const j = buildGroupJournal({ sessions, members, entries });

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
        level: m.student.academyLevel,
        summary: summarize(studentLessons(j, m.studentId).map((x) => x.mark)),
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName, 'ru'));

    const perStudent = new Map(students.map((s) => [s.id, weekAverages(j, s.id)]));
    const groupAvg = groupWeekAverages(
      j,
      students.map((s) => s.id),
    );

    return {
      group,
      canEditAll,
      canManage: isAcademyManager(user),
      today: tjLocalDay(),
      lessons: j.lessons,
      sheet: mapToRecord(j.sheet),
      marks: Object.fromEntries([...j.marks].map(([lessonId, byStudent]) => [lessonId, mapToRecord(byStudent)])),
      students,
      weeks: j.weeks.map((w) => ({
        ...w,
        groupAvg: groupAvg.get(w.key) ?? null,
        values: Object.fromEntries(
          students.flatMap((s) => {
            const v = perStudent.get(s.id)?.get(w.key);
            return v === undefined ? [] : [[s.id, v]];
          }),
        ),
      })),
    };
  }

  /**
   * Строки листа урока (пакетом): посещение, три процента, комментарий.
   * undefined — не трогать, null — стереть. «Не был» стирает проценты;
   * процент без отметки (или у «не был») ставит «был».
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
      select: ENTRY_SELECT,
    });
    const byStudent = new Map(existing.map((e) => [e.studentId, e]));
    const updatedById = user?.id ?? null;

    const saved = await this.prisma.$transaction(
      dto.items.map((item) => {
        const prev = byStudent.get(item.studentId);
        let attendance = prev ? attendanceOf(prev) : null;
        let homeworkPct = prev?.homeworkPct ?? null;
        let vocabularyPct = prev?.vocabularyPct ?? null;
        let performancePct = prev?.performancePct ?? null;
        let comment = prev?.comment ?? null;
        if (item.attendance !== undefined) attendance = item.attendance;
        if (item.homeworkPct !== undefined) homeworkPct = item.homeworkPct;
        if (item.vocabularyPct !== undefined) vocabularyPct = item.vocabularyPct;
        if (item.performancePct !== undefined) performancePct = item.performancePct;
        if (item.comment !== undefined) comment = item.comment?.trim().slice(0, 500) || null;
        if (item.attendance === 'ABSENT' || item.attendance === null) {
          homeworkPct = null;
          vocabularyPct = null;
          performancePct = null;
        } else if (
          (homeworkPct !== null || vocabularyPct !== null || performancePct !== null) &&
          (attendance === null || attendance === 'ABSENT')
        ) {
          attendance = 'PRESENT';
        }
        const data = {
          attendance,
          present: attendance === null ? null : attendance !== 'ABSENT',
          homeworkPct,
          vocabularyPct,
          performancePct,
          comment,
          updatedById,
        };
        return this.prisma.journalEntry.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: item.studentId } },
          create: { sessionId: session.id, studentId: item.studentId, ...data },
          update: data,
          select: ENTRY_SELECT,
        });
      }),
    );

    // Урок отмечен — значит состоялся.
    if (session.status === ClassSessionStatus.SCHEDULED && saved.some((e) => e.attendance !== null)) {
      await this.prisma.classSession.update({
        where: { id: session.id },
        data: { status: ClassSessionStatus.DONE },
      });
    }
    return { sessionId: session.id, entries: saved.map((e) => ({ studentId: e.studentId, ...markOf(e) })) };
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
      const path = materialFilePath(m.url);
      if (path) await fsp.unlink(path).catch(() => undefined);
    }
    return { ok: true };
  }

  // ──────────────────────────────── УРОВНИ ─────────────────────────────────

  private levelsOrdered() {
    return this.prisma.academyLevel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, sortOrder: true, _count: { select: { students: true } } },
    });
  }

  /** Список уровней по порядку — для выбора в формах и страницы «Уровни». */
  async listLevels(user: AcademyViewer) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const rows = await this.levelsOrdered();
    return rows.map((l) => ({ id: l.id, name: l.name, sortOrder: l.sortOrder, students: l._count.students }));
  }

  private normalizeLevelName(raw: string): string {
    const name = (raw || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new BadRequestException('Напишите название уровня');
    if (/[<>]/.test(name)) throw new BadRequestException('Название содержит недопустимые символы');
    return name.slice(0, 60);
  }

  private async assertLevelNameFree(name: string, exceptId?: string) {
    const dup = await this.prisma.academyLevel.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('Такой уровень уже есть');
  }

  async createLevel(user: AcademyViewer, dto: AcademyLevelDto) {
    assertAcademyCan(user, 'academy:levels');
    const name = this.normalizeLevelName(dto.name);
    await this.assertLevelNameFree(name);
    const last = await this.prisma.academyLevel.aggregate({ _max: { sortOrder: true } });
    await this.prisma.academyLevel.create({ data: { name, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    return this.listLevels(user);
  }

  async renameLevel(user: AcademyViewer, id: string, dto: AcademyLevelDto) {
    assertAcademyCan(user, 'academy:levels');
    const level = await this.prisma.academyLevel.findUnique({ where: { id }, select: { id: true } });
    if (!level) throw new NotFoundException('Уровень не найден');
    const name = this.normalizeLevelName(dto.name);
    await this.assertLevelNameFree(name, id);
    await this.prisma.academyLevel.update({ where: { id }, data: { name } });
    return this.listLevels(user);
  }

  /** Удалить можно только уровень, которого нет ни у одного ученика. */
  async deleteLevel(user: AcademyViewer, id: string) {
    assertAcademyCan(user, 'academy:levels');
    const level = await this.prisma.academyLevel.findUnique({
      where: { id },
      select: { id: true, name: true, _count: { select: { students: true } } },
    });
    if (!level) throw new NotFoundException('Уровень не найден');
    if (level._count.students > 0) {
      throw new BadRequestException(
        `Уровень «${level.name}» стоит у ${studentsGen(level._count.students)} — сначала смените им уровень`,
      );
    }
    await this.prisma.academyLevel.delete({ where: { id } });
    return this.listLevels(user);
  }

  /** Новый порядок — полный список id уровней сверху вниз. */
  async reorderLevels(user: AcademyViewer, dto: ReorderLevelsDto) {
    assertAcademyCan(user, 'academy:levels');
    const all = await this.prisma.academyLevel.findMany({ select: { id: true } });
    const ids = Array.from(new Set(dto.ids));
    if (ids.length !== all.length || !all.every((l) => ids.includes(l.id))) {
      throw new BadRequestException('Список уровней изменился — обновите страницу');
    }
    await this.prisma.$transaction(
      ids.map((id, i) => this.prisma.academyLevel.update({ where: { id }, data: { sortOrder: i } })),
    );
    return this.listLevels(user);
  }

  /** «Заполнить стандартными» — только пока список пуст. */
  async seedDefaultLevels(user: AcademyViewer) {
    assertAcademyCan(user, 'academy:levels');
    const count = await this.prisma.academyLevel.count();
    if (count > 0) throw new BadRequestException('Список уровней уже заполнен');
    await this.prisma.academyLevel.createMany({
      data: DEFAULT_LEVELS.map((name, i) => ({ name, sortOrder: i })),
    });
    return this.listLevels(user);
  }

  private async assertLevelExists(levelId: string) {
    const level = await this.prisma.academyLevel.findUnique({ where: { id: levelId }, select: { id: true, name: true } });
    if (!level) throw new BadRequestException('Уровень не найден — обновите список уровней');
    return level;
  }

  // ──────────────────────────────── УЧЕНИКИ ────────────────────────────────

  /**
   * Ученики академии: заведённые в академии + студенты агентства, которые
   * состоят или состояли в группах. Учитель видит только тех, кто учился в
   * его группах. Поиск — по ФИО, e-mail и цифрам телефона.
   */
  async listStudents(
    user: AcademyViewer,
    f: { search?: string; groupId?: string; teacherId?: string; status?: string; type?: string; levelId?: string },
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
    if (f.levelId === 'NONE') and.push({ academyLevelId: null });
    else if (f.levelId) and.push({ academyLevelId: f.levelId });

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
        academyLevel: LEVEL_REF,
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

    const marks = await this.marksByStudent(
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
        level: s.academyLevel,
        groups: activeGroups.map((m) => ({
          id: m.group.id,
          name: m.group.name,
          status: m.group.status,
          teacher: m.group.teacher,
        })),
        summary: summarize(marks.get(s.id) ?? []),
      };
    });

    const counts: Record<AcademyStatus | 'ALL', number> = { ALL: items.length, ACTIVE: 0, PENDING: 0, EXPELLED: 0, NO_GROUP: 0 };
    for (const it of items) counts[it.status]++;

    const byStatus = f.status && f.status in counts && f.status !== 'ALL' ? items.filter((i) => i.status === f.status) : items;
    byStatus.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    return { items: byStatus, counts };
  }

  /**
   * Журналы групп, урезанные до переданных членств: одна выборка занятий и
   * отметок на все группы, затем общая формула journal-math.
   */
  private async journalsByGroup(memberships: MembershipRow[]): Promise<Map<string, GroupJournal>> {
    const out = new Map<string, GroupJournal>();
    const groupIds = Array.from(new Set(memberships.map((m) => m.groupId)));
    if (!groupIds.length) return out;
    const studentIds = Array.from(new Set(memberships.map((m) => m.studentId)));
    const [sessions, entries] = await Promise.all([
      this.prisma.classSession.findMany({
        where: { groupId: { in: groupIds } },
        select: { ...SESSION_SELECT, groupId: true },
      }),
      this.prisma.journalEntry.findMany({
        where: { studentId: { in: studentIds }, session: { groupId: { in: groupIds } } },
        select: ENTRY_SELECT,
      }),
    ]);
    for (const gid of groupIds) {
      const gSessions = sessions.filter((s) => s.groupId === gid);
      const ids = new Set(gSessions.map((s) => s.id));
      out.set(
        gid,
        buildGroupJournal({
          sessions: gSessions,
          members: memberships.filter((m) => m.groupId === gid),
          entries: entries.filter((e) => ids.has(e.sessionId)),
        }),
      );
    }
    return out;
  }

  /** Отметки учеников по всем их группам — для сводок. */
  private async marksByStudent(memberships: MembershipRow[]): Promise<Map<string, Array<LessonMark | null>>> {
    const out = new Map<string, Array<LessonMark | null>>();
    const perGroup = await this.journalsByGroup(memberships);
    for (const m of memberships) {
      const j = perGroup.get(m.groupId);
      if (!j) continue;
      const list = out.get(m.studentId) ?? [];
      list.push(...studentLessons(j, m.studentId).map((x) => x.mark));
      out.set(m.studentId, list);
    }
    return out;
  }

  /**
   * Поиск для «Добавить в группу».
   *   Руководство — студенты агентства и ученики академии по ФИО, e-mail
   *   или цифрам телефона (от 2 символов).
   *   Учитель — только ученики академии, которые сейчас ни в одной группе
   *   (и не отчислены): клиентов агентства и чужих учеников он не видит.
   *   Список показывается сразу, поиск сужает его.
   */
  async pickStudents(user: AcademyViewer, search: string, groupId?: string) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const q = (search || '').trim();
    const digits = q.replace(/\D/g, '');
    const select = {
      id: true,
      fullName: true,
      phones: true,
      email: true,
      academyOnly: true,
      academyExpelledAt: true,
      academyLevel: LEVEL_REF,
      groupMemberships: { where: { leftAt: null }, select: { groupId: true, group: { select: { name: true } } } },
    } as const;
    type Row = Prisma.StudentGetPayload<{ select: typeof select }>;
    const shape = (s: Row) => ({
      id: s.id,
      fullName: s.fullName,
      phone: s.phones[0] || null,
      email: s.email,
      academyOnly: s.academyOnly,
      expelled: !!s.academyExpelledAt,
      level: s.academyLevel,
      inGroup: groupId ? s.groupMemberships.some((m) => m.groupId === groupId) : false,
      groups: s.groupMemberships.map((m) => m.group.name),
    });

    if (!isAcademyManager(user)) {
      if (!groupId) throw new BadRequestException('Не указана группа');
      const g = await this.prisma.studyGroup.findUnique({ where: { id: groupId }, select: { teacherId: true } });
      if (!g) throw new NotFoundException('Группа не найдена');
      if (!teachesGroup(user, g)) throw new ForbiddenException('Это не ваша группа');
      // Учеников без группы немного — берём всех и фильтруем на месте
      // (телефон — по цифрам, как в списке учеников).
      const base = await this.prisma.student.findMany({
        where: {
          AND: [
            { OR: [{ academyOnly: true }, { groupMemberships: { some: {} } }] },
            { academyExpelledAt: null },
            { groupMemberships: { none: { leftAt: null } } },
          ],
        },
        orderBy: { fullName: 'asc' },
        take: STUDENTS_TAKE_LIMIT,
        select,
      });
      const ql = q.toLowerCase();
      const found = q
        ? base.filter(
            (s) =>
              s.fullName.toLowerCase().includes(ql) ||
              (s.email || '').toLowerCase().includes(ql) ||
              (digits.length >= 3 && s.phones.some((p) => p.replace(/\D/g, '').includes(digits))),
          )
        : base;
      return found.slice(0, TEACHER_PICK_LIMIT).map(shape);
    }

    if (q.length < 2) return [];
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
    let byPhone: Row[] = [];
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
      .map(shape);
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
        phoneLabels: true,
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
        academyLevelId: true,
        academyLevel: LEVEL_REF,
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
            group: {
              select: { id: true, name: true, status: true, teacherId: true, teacher: USER_REF, completedAt: true },
            },
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

  /** Ученик сейчас учится в группе этого учителя — учитель правит его данные и уровень. */
  private teachesStudentNow(
    user: AcademyViewer,
    s: { groupMemberships: Array<{ leftAt: Date | null; group: { teacherId: string | null } }> },
  ): boolean {
    return s.groupMemberships.some((m) => !m.leftAt && teachesGroup(user, m.group));
  }

  /** Карточка ученика академии: контакты, уровень, группы с уроками, флаги, дневник ДЗ, комментарии. */
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
    const perGroup = await this.journalsByGroup(memberships);
    const allMarks: Array<LessonMark | null> = [];
    const groups = s.groupMemberships.map((m) => {
      const j = perGroup.get(m.groupId);
      const lessons = j ? studentLessons(j, s.id) : [];
      allMarks.push(...lessons.map((x) => x.mark));
      const weekly = j ? weekAverages(j, s.id) : new Map<string, number>();
      return {
        membershipId: m.id,
        group: m.group,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        leftReason: m.leftReason,
        active: !m.leftAt,
        summary: summarize(lessons.map((x) => x.mark)),
        lessons: lessons
          .filter((x) => x.lesson.past || x.mark)
          .map((x) => ({
            id: x.lesson.id,
            number: x.lesson.number,
            startsAt: x.lesson.startsAt,
            topic: x.lesson.topic,
            mark: x.mark,
          })),
        weeks: (j?.weeks ?? [])
          .filter((w) => weekly.has(w.key))
          .map((w) => ({ key: w.key, index: w.index, from: w.from, to: w.to, value: weekly.get(w.key)! })),
      };
    });

    const [comments, levelHistory, diary] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where: { studentId: s.id, comment: { not: null } },
        orderBy: { session: { startsAt: 'desc' } },
        take: RECENT_COMMENTS,
        select: {
          ...ENTRY_SELECT,
          updatedBy: { select: { id: true, fullName: true } },
          session: { select: { id: true, startsAt: true, topic: true, group: { select: { id: true, name: true } } } },
        },
      }),
      this.levelHistoryOf(s.id),
      this.diaryOfStudent(s.id, memberships),
    ]);

    const activeFlags = s.redFlags.filter((f) => !f.removedAt);
    const activeGroups = s.groupMemberships.filter((m) => !m.leftAt);
    const status = academyStatusOf({
      academyExpelledAt: s.academyExpelledAt,
      academyFlagsReviewedAt: s.academyFlagsReviewedAt,
      activeFlagDates: activeFlags.map((f) => f.createdAt),
      activeGroups: activeGroups.length,
    });
    const manager = isAcademyManager(user);
    const mine = this.teachesStudentNow(user, s);
    const myActiveGroups = activeGroups.filter((m) => manager || teachesGroup(user, m.group)).map((m) => m.group);
    const parents = parentPhonesOf(s.phones, s.phoneLabels);

    return {
      id: s.id,
      fullName: s.fullName,
      phones: s.phones,
      phoneLabels: s.phoneLabels,
      fatherPhone: parents.father,
      motherPhone: parents.mother,
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
      level: s.academyLevel,
      levelHistory,
      flagsActive: activeFlags.length,
      expelled: s.academyExpelledAt
        ? { at: s.academyExpelledAt, note: s.academyExpelNote, by: s.academyExpelledBy }
        : null,
      flags: s.redFlags,
      groups,
      summary: summarize(allMarks),
      diary,
      comments: comments.map((c) => ({
        comment: c.comment,
        mark: markOf(c),
        author: c.updatedBy,
        sessionId: c.session.id,
        date: c.session.startsAt,
        topic: c.session.topic,
        group: c.session.group,
      })),
      canManage: manager,
      // Кнопки карточки — те же проверки, что у действий (сотруднику с ролью
      // нужна ещё галочка: «Ученики академии — …», «Ведение», «Флаги — …»).
      canEdit: s.academyOnly && (manager || mine) && roleHas(user, 'academy:students-update'),
      canEditLevel: (manager || mine) && roleHas(user, 'academy:students-update'),
      canResetPassword: s.academyOnly && (manager || mine) && roleHas(user, 'academy:students-password'),
      canFlag: !s.academyExpelledAt && myActiveGroups.length > 0 && roleHas(user, 'groups:write'),
      canRemoveFlags: academyCan(user, 'academy:flags-remove'),
      canDecide: academyCan(user, 'academy:decide'),
      flagGroups: myActiveGroups.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  private async levelHistoryOf(studentId: string) {
    return this.prisma.academyLevelChange.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        fromName: true,
        toName: true,
        reason: true,
        createdAt: true,
        group: { select: { id: true, name: true } },
        changedBy: { select: { id: true, fullName: true } },
      },
    });
  }

  /**
   * Дневник ДЗ ученика по последним урокам с заданием (в его группах, за
   * время членства): дни с урока по срок и записи по дням.
   */
  private async diaryOfStudent(studentId: string, memberships: MembershipRow[]) {
    if (!memberships.length) return [];
    const sessions = await this.prisma.classSession.findMany({
      where: {
        groupId: { in: memberships.map((m) => m.groupId) },
        status: { not: ClassSessionStatus.CANCELLED },
        homework: { not: null },
        startsAt: { lte: new Date() },
      },
      orderBy: { startsAt: 'desc' },
      take: RECENT_DIARIES * 3,
      select: {
        id: true,
        groupId: true,
        startsAt: true,
        topic: true,
        homework: true,
        homeworkDue: true,
        homeworkSetAt: true,
        group: { select: { id: true, name: true } },
        homeworkLogs: { where: { studentId }, select: { day: true, text: true, createdAt: true, updatedAt: true } },
      },
    });
    return sessions
      .filter((x) => {
        const m = memberships.find((mm) => mm.groupId === x.groupId);
        if (!m) return false;
        if (x.homeworkLogs.length) return true;
        return tjLocalDay(x.startsAt) >= tjLocalDay(m.joinedAt) && (!m.leftAt || x.startsAt <= m.leftAt);
      })
      .slice(0, RECENT_DIARIES)
      .map((x) => {
        const m = memberships.find((mm) => mm.groupId === x.groupId);
        return this.diaryShape(x, m ? tjLocalDay(m.joinedAt) : undefined);
      });
  }

  /**
   * Окно дневника: с выдачи задания (не раньше дня урока и прихода ученика в
   * группу) по срок — и шире, если записи остались за его пределами (срок
   * сдвинули).
   */
  private diaryShape(x: {
    id: string;
    startsAt: Date;
    topic: string | null;
    homework: string | null;
    homeworkDue: Date | null;
    homeworkSetAt: Date | null;
    group: { id: string; name: string };
    homeworkLogs: Array<{ day: string; text: string; createdAt: Date; updatedAt: Date }>;
  }, joinedDay?: string) {
    const issued = diaryStart(x.startsAt, x.homeworkSetAt);
    const start = joinedDay && joinedDay > issued ? joinedDay : issued;
    const from = x.homeworkLogs.reduce((acc, l) => (l.day < acc ? l.day : acc), start);
    const due = dueKey(x.homeworkDue) ?? start;
    const lastLog = x.homeworkLogs.reduce((acc, l) => (l.day > acc ? l.day : acc), due);
    return {
      sessionId: x.id,
      startsAt: x.startsAt,
      topic: x.topic,
      homework: x.homework,
      homeworkDue: x.homeworkDue,
      group: x.group,
      days: diaryDays(from, lastLog > due ? lastLog : due),
      logs: Object.fromEntries(
        x.homeworkLogs.map((l) => [l.day, { text: l.text, createdAt: l.createdAt, updatedAt: l.updatedAt }]),
      ),
    };
  }

  private normalizeEmail(raw: string): string {
    const email = (raw || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new BadRequestException('E-mail указан неверно');
    return email;
  }

  private normalizePhone(raw: string, what = 'Телефон'): string {
    const phone = (raw || '').trim();
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) throw new BadRequestException(`${what} указан неверно`);
    return phone;
  }

  /** Необязательный телефон родителя: пусто — нет номера. */
  private optionalPhone(raw: string | undefined, what: string): string | null {
    const v = (raw || '').trim();
    if (!v || v.replace(/\D/g, '').length <= 3) return null; // пустой или только код страны
    return this.normalizePhone(v, what);
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
   *
   * Заводят руководство (в любую группу или без группы) и учитель — только
   * сразу в свою действующую группу.
   */
  async createStudent(user: AcademyViewer, dto: CreateAcademyStudentDto) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    assertRoleHas(user, 'academy:students-create', 'Нет права заводить учеников');
    const manager = isAcademyManager(user);
    if (!manager) {
      if (!dto.groupId) throw new BadRequestException('Выберите свою группу');
      const g = await this.prisma.studyGroup.findUnique({ where: { id: dto.groupId }, select: { teacherId: true } });
      if (!g) throw new NotFoundException('Группа не найдена');
      if (!teachesGroup(user, g)) throw new ForbiddenException('Это не ваша группа');
    }
    const fullName = this.normalizeName(dto.fullName);
    const phone = this.normalizePhone(dto.phone);
    const father = this.optionalPhone(dto.fatherPhone, 'Телефон отца');
    const mother = this.optionalPhone(dto.motherPhone, 'Телефон матери');
    const email = this.normalizeEmail(dto.email);
    const birthday = this.parseBirthday(dto.birthday);
    await this.assertEmailFree(email);
    if (dto.groupId) await this.assertActiveGroup(dto.groupId);
    const level = dto.levelId ? await this.assertLevelExists(dto.levelId) : null;

    const password = generatePassword(8);
    const contacts = withParents([], [], phone, father, mother);
    const student = await this.prisma.student.create({
      data: {
        fullName,
        phones: contacts.phones,
        phoneLabels: contacts.phoneLabels,
        email,
        password: await bcrypt.hash(password, 10),
        birthday,
        comment: dto.comment?.trim().slice(0, 1000) || null,
        direction: Direction.BACHELOR,
        directionConfirmed: false,
        cabinet: DEFAULT_CABINET,
        academyOnly: true,
        academyLevelId: level?.id ?? null,
        ...(dto.groupId ? { groupMemberships: { create: { groupId: dto.groupId } } } : {}),
        ...(level
          ? { academyLevelChanges: { create: { toName: level.name, reason: 'START', changedById: user.id } } }
          : {}),
      },
      select: { id: true, fullName: true, email: true },
    });
    return { ...student, password };
  }

  /**
   * Правка ученика. Данные (ФИО, телефоны, e-mail…) — только у ученика
   * академии: агентского студента правят в его карточке CRM. Уровень — у
   * любого ученика академии. Правят руководство и учитель, у которого
   * ученик сейчас учится.
   */
  async updateStudent(user: AcademyViewer, id: string, dto: UpdateAcademyStudentDto) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const s = await this.loadAcademyStudent(id);
    if (!s || !this.isAcademyStudent(s)) throw new NotFoundException('Ученик не найден');
    assertRoleHas(user, 'academy:students-update', 'Нет права изменять учеников');
    if (!isAcademyManager(user) && !this.teachesStudentNow(user, s)) {
      throw new ForbiddenException('Это не ваш ученик');
    }
    const touchesProfile =
      dto.fullName !== undefined ||
      dto.phone !== undefined ||
      dto.email !== undefined ||
      dto.birthday !== undefined ||
      dto.comment !== undefined ||
      dto.fatherPhone !== undefined ||
      dto.motherPhone !== undefined;
    if (touchesProfile && !s.academyOnly) {
      throw new BadRequestException('Данные студента агентства меняются в его карточке CRM');
    }

    const data: Prisma.StudentUncheckedUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = this.normalizeName(dto.fullName);
    if (dto.phone !== undefined || dto.fatherPhone !== undefined || dto.motherPhone !== undefined) {
      const current = parentPhonesOf(s.phones, s.phoneLabels);
      const own = dto.phone !== undefined ? this.normalizePhone(dto.phone) : s.phones[0] || '';
      if (!own) throw new BadRequestException('Телефон указан неверно');
      const father = dto.fatherPhone !== undefined ? this.optionalPhone(dto.fatherPhone, 'Телефон отца') : current.father;
      const mother = dto.motherPhone !== undefined ? this.optionalPhone(dto.motherPhone, 'Телефон матери') : current.mother;
      const contacts = withParents(s.phones, s.phoneLabels, own, father, mother);
      data.phones = contacts.phones;
      data.phoneLabels = contacts.phoneLabels;
    }
    if (dto.email !== undefined) {
      const email = this.normalizeEmail(dto.email);
      await this.assertEmailFree(email, id);
      data.email = email;
    }
    if (dto.birthday !== undefined) data.birthday = this.parseBirthday(dto.birthday);
    if (dto.comment !== undefined) data.comment = dto.comment.trim().slice(0, 1000) || null;

    let levelChange: Prisma.AcademyLevelChangeUncheckedCreateInput | null = null;
    if (dto.levelId !== undefined) {
      const next = dto.levelId.trim() ? await this.assertLevelExists(dto.levelId.trim()) : null;
      if ((next?.id ?? null) !== s.academyLevelId) {
        data.academyLevelId = next?.id ?? null;
        levelChange = {
          studentId: s.id,
          fromName: s.academyLevel?.name ?? null,
          toName: next?.name ?? null,
          reason: 'MANUAL',
          changedById: user.id,
        };
      }
    }
    await this.prisma.$transaction([
      this.prisma.student.update({ where: { id }, data }),
      ...(levelChange ? [this.prisma.academyLevelChange.create({ data: levelChange })] : []),
    ]);
    return this.getStudent(user, id);
  }

  /** Новый пароль ученику академии (старые входы перестают работать). */
  async resetPassword(user: AcademyViewer, id: string) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const s = await this.loadAcademyStudent(id);
    if (!s) throw new NotFoundException('Ученик не найден');
    assertRoleHas(user, 'academy:students-password', 'Нет права менять пароль ученика');
    if (!isAcademyManager(user) && !this.teachesStudentNow(user, s)) {
      throw new ForbiddenException('Это не ваш ученик');
    }
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

  // ─────────────────────────── ЗАВЕРШЕНИЕ КУРСА ────────────────────────────

  private async groupForCourse(user: AcademyViewer, groupId: string) {
    const g = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        status: true,
        teacherId: true,
        completedAt: true,
        members: {
          where: { leftAt: null },
          select: {
            studentId: true,
            student: { select: { id: true, fullName: true, photoUrl: true, academyLevelId: true, academyLevel: LEVEL_REF } },
          },
        },
      },
    });
    if (!g) throw new NotFoundException('Группа не найдена');
    // Завершить курс: должность — кто ведёт группу; роль — «Завершение курса».
    if (!academyGroupCan(user, g, 'academy:complete', () => canRunGroup(user, g))) {
      throw new ForbiddenException('Это не ваша группа');
    }
    return g;
  }

  /**
   * Окно «Завершить курс»: ученики группы, их уровень и предложенный
   * следующий (по порядку «Академия → Уровни»; у последнего — тот же).
   */
  async coursePreview(user: AcademyViewer, groupId: string) {
    const g = await this.groupForCourse(user, groupId);
    const levels = await this.levelsOrdered();
    const next = (levelId: string | null) => {
      if (!levelId) return null;
      const i = levels.findIndex((l) => l.id === levelId);
      if (i < 0) return null;
      return levels[i + 1]?.id ?? levels[i].id;
    };
    const futureLessons = await this.prisma.classSession.count({
      where: { groupId, status: ClassSessionStatus.SCHEDULED, startsAt: { gt: new Date() } },
    });
    return {
      group: { id: g.id, name: g.name, status: g.status, completedAt: g.completedAt },
      levels: levels.map((l) => ({ id: l.id, name: l.name })),
      futureLessons,
      students: g.members
        .map((m) => ({
          id: m.student.id,
          fullName: m.student.fullName,
          photoUrl: m.student.photoUrl,
          level: m.student.academyLevel,
          suggestedLevelId: next(m.student.academyLevelId),
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    };
  }

  /**
   * «Завершить курс»: новые уровни ученикам (с историей), ученики выходят из
   * группы с отметкой «окончил курс» (журнал остаётся), будущие занятия
   * отменяются, группа уходит в архив. Делают учитель группы и руководство.
   */
  async completeCourse(user: AcademyViewer, groupId: string, dto: CompleteCourseDto) {
    const g = await this.groupForCourse(user, groupId);
    if (g.completedAt) throw new BadRequestException('Курс уже завершён');
    if (g.status !== StudyGroupStatus.ACTIVE) throw new BadRequestException('Группа в архиве');
    const members = new Map(g.members.map((m) => [m.studentId, m.student]));
    const levels = await this.prisma.academyLevel.findMany({ select: { id: true, name: true } });
    const levelById = new Map(levels.map((l) => [l.id, l]));

    const changes: Prisma.PrismaPromise<unknown>[] = [];
    const seen = new Set<string>();
    let changed = 0;
    for (const item of dto.items) {
      if (seen.has(item.studentId)) continue;
      seen.add(item.studentId);
      const st = members.get(item.studentId);
      if (!st) throw new BadRequestException('Ученик не состоит в этой группе');
      if (item.levelId === undefined) continue;
      const nextLevel = item.levelId ? levelById.get(item.levelId) : null;
      if (item.levelId && !nextLevel) throw new BadRequestException('Уровень не найден — обновите окно');
      if ((nextLevel?.id ?? null) === st.academyLevelId) continue;
      changed++;
      changes.push(
        this.prisma.student.update({ where: { id: st.id }, data: { academyLevelId: nextLevel?.id ?? null } }),
        this.prisma.academyLevelChange.create({
          data: {
            studentId: st.id,
            fromName: st.academyLevel?.name ?? null,
            toName: nextLevel?.name ?? null,
            reason: 'COURSE',
            groupId,
            changedById: user!.id,
          },
        }),
      );
    }

    const now = new Date();
    const res = await this.prisma.$transaction([
      ...changes,
      this.prisma.groupMember.updateMany({
        where: { groupId, leftAt: null },
        data: { leftAt: now, leftReason: 'COMPLETED' },
      }),
      this.prisma.studyGroup.update({
        where: { id: groupId },
        data: { status: StudyGroupStatus.ARCHIVED, completedAt: now, completedById: user!.id },
      }),
      this.prisma.classSession.updateMany({
        where: { groupId, status: ClassSessionStatus.SCHEDULED, startsAt: { gt: now } },
        data: { status: ClassSessionStatus.CANCELLED },
      }),
    ]);
    const cancelled = res[res.length - 1] as { count: number };
    return { ok: true, changed, students: members.size, cancelledLessons: cancelled.count };
  }

  // ───────────────────────────── КРАСНЫЕ ФЛАГИ ─────────────────────────────

  /**
   * Красный флаг — учитель своему ученику (в своей группе) или руководство.
   * Когда действующих флагов 4+ и среди них есть новый после последнего
   * «Оставить», руководству уходит уведомление «нужно решение».
   */
  async giveFlag(user: AcademyViewer, studentId: string, dto: GiveFlagDto) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const s = await this.loadAcademyStudent(studentId);
    if (!s || !this.isAcademyStudent(s)) throw new NotFoundException('Ученик академии не найден');
    if (s.academyExpelledAt) throw new BadRequestException('Ученик уже отчислен');
    // Флаг ставит тот, кто ведёт группу: роли нужно «Ведение».
    assertRoleHas(user, 'groups:write', 'Нет права ставить флаги');
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
    assertAcademyCan(user, 'academy:flags-remove');
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
   * 4-го флага): ученик выходит из всех групп, оценки остаются. KEEP —
   * оставить: флаги до этого момента считаются рассмотренными.
   */
  async decide(user: AcademyViewer, studentId: string, dto: AcademyDecisionDto) {
    assertAcademyCan(user, 'academy:decide');
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
    assertAcademyCan(user, 'academy:decide');
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

  // ─────────────────────────────── ДНЕВНИК ДЗ ──────────────────────────────

  /**
   * Дневник ДЗ урока для учителя: ученики × дни (с дня урока по срок) и
   * записи. Открывают руководство, учитель группы и подменный учитель урока.
   */
  async sessionDiary(user: AcademyViewer, sessionId: string) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        groupId: true,
        startsAt: true,
        endsAt: true,
        status: true,
        topic: true,
        homework: true,
        homeworkDue: true,
        homeworkSetAt: true,
        teacherId: true,
        group: { select: { id: true, name: true, teacherId: true } },
      },
    });
    if (!session) throw new NotFoundException('Занятие не найдено');
    if (!canMarkSession(user, session)) throw new ForbiddenException('Это не ваш урок');

    const [logs, members] = await Promise.all([
      this.prisma.homeworkLog.findMany({
        where: { sessionId },
        select: { studentId: true, day: true, text: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.groupMember.findMany({
        where: { groupId: session.groupId },
        select: {
          studentId: true,
          joinedAt: true,
          leftAt: true,
          student: { select: { id: true, fullName: true, photoUrl: true } },
        },
      }),
    ]);
    const start = diaryStart(session.startsAt, session.homeworkSetAt);
    const from = logs.reduce((acc, l) => (l.day < acc ? l.day : acc), start);
    const due = dueKey(session.homeworkDue) ?? start;
    const lastLog = logs.reduce((acc, l) => (l.day > acc ? l.day : acc), due);
    const days = diaryDays(from, lastLog);
    const writers = new Set(logs.map((l) => l.studentId));
    const students = members
      .filter((m) => !m.leftAt || m.leftAt >= session.startsAt || writers.has(m.studentId))
      .map((m) => ({
        id: m.student.id,
        fullName: m.student.fullName,
        photoUrl: m.student.photoUrl,
        active: !m.leftAt,
        // До прихода в группу дни дневника ученику не засчитываются.
        joinedDay: tjLocalDay(m.joinedAt),
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName, 'ru'));

    const byStudent: Record<string, Record<string, { text: string; createdAt: Date; updatedAt: Date }>> = {};
    for (const l of logs) {
      (byStudent[l.studentId] ??= {})[l.day] = { text: l.text, createdAt: l.createdAt, updatedAt: l.updatedAt };
    }
    return {
      session: {
        id: session.id,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        status: session.status,
        topic: session.topic,
        homework: session.homework,
        homeworkDue: session.homeworkDue,
        group: { id: session.group.id, name: session.group.name },
      },
      today: tjLocalDay(),
      days,
      students,
      logs: byStudent,
    };
  }

  /**
   * Запись ученика в дневник ДЗ — только за сегодняшний день (Душанбе), в
   * окне с дня урока по срок. Сегодняшнюю запись можно поправить до конца
   * дня; прошедшие дни задним числом не пишутся.
   */
  async writeDiary(studentId: string, dto: HomeworkLogDto) {
    const text = dto.text.trim();
    if (!text) throw new BadRequestException('Напишите, что вы сделали');
    const session = await this.prisma.classSession.findUnique({
      where: { id: dto.sessionId },
      select: { id: true, groupId: true, startsAt: true, status: true, homework: true, homeworkDue: true, homeworkSetAt: true },
    });
    if (!session || !session.homework || session.status === ClassSessionStatus.CANCELLED) {
      throw new NotFoundException('Задание не найдено');
    }
    const member = await this.prisma.groupMember.findUnique({
      where: { groupId_studentId: { groupId: session.groupId, studentId } },
      select: { leftAt: true },
    });
    if (!member || member.leftAt) throw new ForbiddenException('Это задание не вашей группы');
    if (session.startsAt.getTime() > Date.now()) throw new BadRequestException('Урок ещё не начался');
    const today = tjLocalDay();
    const from = diaryStart(session.startsAt, session.homeworkSetAt);
    const to = dueKey(session.homeworkDue) ?? from;
    if (today > to) throw new BadRequestException('Срок задания прошёл — дневник закрыт');
    if (today < from) throw new BadRequestException('Урок ещё не начался');

    const saved = await this.prisma.homeworkLog.upsert({
      where: { sessionId_studentId_day: { sessionId: session.id, studentId, day: today } },
      create: { sessionId: session.id, studentId, day: today, text: text.slice(0, 2000) },
      update: { text: text.slice(0, 2000) },
      select: { day: true, text: true, createdAt: true, updatedAt: true },
    });
    return saved;
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

    const marks = await this.marksByStudent(
      s.groupMemberships.map((m) => ({ groupId: m.groupId, studentId: s.id, joinedAt: m.joinedAt, leftAt: m.leftAt })),
    );
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
      level: s.academyLevel,
      flagsActive: activeFlags.length,
      groups: activeGroups.map((m) => ({ id: m.group.id, name: m.group.name, teacher: m.group.teacher })),
      summary: summarize(marks.get(s.id) ?? []),
    };
  }

  // ──────────────────────────── КАБИНЕТ СТУДЕНТА ───────────────────────────

  /** Главная вкладки «Академия»: статус, уровень, группы, флаги, сводка, дневник на сегодня. */
  async cabinetOverview(studentId: string) {
    const s = await this.loadAcademyStudent(studentId);
    if (!s) throw new NotFoundException('Студент не найден');
    if (!this.isAcademyStudent(s)) return { hasAcademy: false as const, academyOnly: false };

    const marks = await this.marksByStudent(
      s.groupMemberships.map((m) => ({ groupId: m.groupId, studentId: s.id, joinedAt: m.joinedAt, leftAt: m.leftAt })),
    );
    const activeFlags = s.redFlags.filter((f) => !f.removedAt);
    const active = s.groupMemberships.filter((m) => !m.leftAt);

    // Ближайшее занятие и «по каким дням» — по ближайшим неделям расписания.
    const now = new Date();
    const horizon = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
    const [upcoming, levelHistory, diaryDue] = await Promise.all([
      active.length
        ? this.prisma.classSession.findMany({
            where: {
              groupId: { in: active.map((m) => m.groupId) },
              status: { not: ClassSessionStatus.CANCELLED },
              endsAt: { gte: now },
              startsAt: { lte: horizon },
            },
            orderBy: { startsAt: 'asc' },
            select: { groupId: true, startsAt: true, endsAt: true, topic: true },
          })
        : Promise.resolve([] as Array<{ groupId: string; startsAt: Date; endsAt: Date; topic: string | null }>),
      this.levelHistoryOf(s.id),
      this.diaryDueToday(s.id, active.map((m) => m.groupId)),
    ]);

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
      level: s.academyLevel ? { id: s.academyLevel.id, name: s.academyLevel.name } : null,
      levelHistory: levelHistory.map((h) => ({
        id: h.id,
        fromName: h.fromName,
        toName: h.toName,
        reason: h.reason,
        createdAt: h.createdAt,
        group: h.group,
      })),
      completedCourses: s.groupMemberships
        .filter((m) => m.leftReason === 'COMPLETED')
        .map((m) => ({ id: m.group.id, name: m.group.name, completedAt: m.group.completedAt ?? m.leftAt })),
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
      summary: summarize(marks.get(s.id) ?? []),
      diaryDue,
    };
  }

  /** ДЗ, по которым сегодня ещё нет записи в дневнике (для напоминания). */
  private async diaryDueToday(studentId: string, groupIds: string[]) {
    if (!groupIds.length) return [];
    const today = tjLocalDay();
    const rows = await this.prisma.classSession.findMany({
      where: {
        groupId: { in: groupIds },
        status: { not: ClassSessionStatus.CANCELLED },
        homework: { not: null },
        startsAt: { lte: new Date() },
        homeworkDue: { gte: new Date(`${today}T00:00:00.000Z`) },
      },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        startsAt: true,
        topic: true,
        homeworkDue: true,
        homeworkSetAt: true,
        group: { select: { id: true, name: true } },
        homeworkLogs: { where: { studentId, day: today }, select: { day: true } },
      },
    });
    return rows
      .filter((r) => r.homeworkLogs.length === 0 && diaryStart(r.startsAt, r.homeworkSetAt) <= today)
      .map((r) => ({ sessionId: r.id, startsAt: r.startsAt, topic: r.topic, homeworkDue: r.homeworkDue, group: r.group }));
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

  /**
   * Календарь кабинета: занятия действующих групп за период (с отменёнными —
   * ученик должен видеть, что урока не будет). ДЗ и материалы — только у
   * начавшихся уроков, как в расписании.
   */
  async cabinetCalendar(studentId: string, fromRaw?: string, toRaw?: string) {
    const today = tjLocalDay();
    const from = fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : today;
    const to = toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : from;
    const gte = tjParseLocalDate(from);
    const lte = tjParseLocalDateEnd(to);
    if (Number.isNaN(gte.getTime()) || Number.isNaN(lte.getTime()) || lte < gte) {
      throw new BadRequestException('Период указан неверно');
    }
    if ((lte.getTime() - gte.getTime()) / 86_400_000 > CALENDAR_MAX_DAYS) {
      throw new BadRequestException('Слишком большой период');
    }
    const groupIds = await this.activeGroupIds(studentId);
    if (!groupIds.length) return [];
    const now = Date.now();
    const rows = await this.prisma.classSession.findMany({
      where: { groupId: { in: groupIds }, startsAt: { gte, lte } },
      orderBy: { startsAt: 'asc' },
      take: 500,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        topic: true,
        homework: true,
        homeworkDue: true,
        group: { select: { id: true, name: true, teacher: { select: { fullName: true } } } },
        teacher: { select: { fullName: true } },
        materials: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, kind: true, title: true, url: true, size: true, mimeType: true },
        },
      },
    });
    return rows.map((r) => {
      const started = r.startsAt.getTime() <= now;
      return {
        id: r.id,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        status: r.status,
        topic: r.topic,
        group: { id: r.group.id, name: r.group.name },
        teacher: r.teacher ?? r.group.teacher,
        started,
        homework: started ? r.homework : null,
        homeworkDue: started ? r.homeworkDue : null,
        materials: started
          ? r.materials.map((m) => ({ ...m, url: m.kind === ClassMaterialKind.LINK ? m.url : null }))
          : [],
      };
    });
  }

  /** ДЗ и материалы начавшихся уроков действующих групп — новые сверху, с дневником. */
  async cabinetHomework(studentId: string) {
    const memberships = await this.prisma.groupMember.findMany({
      where: { studentId, leftAt: null },
      select: { groupId: true, joinedAt: true },
    });
    const groupIds = memberships.map((m) => m.groupId);
    if (!groupIds.length) return [];
    const joinedDay = new Map(memberships.map((m) => [m.groupId, tjLocalDay(m.joinedAt)]));
    const today = tjLocalDay();
    const rows = await this.prisma.classSession.findMany({
      where: {
        groupId: { in: groupIds },
        status: { not: ClassSessionStatus.CANCELLED },
        startsAt: { lte: new Date() },
        OR: [{ homework: { not: null } }, { materials: { some: {} } }],
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
        homeworkSetAt: true,
        groupId: true,
        group: { select: { id: true, name: true } },
        materials: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, kind: true, title: true, url: true, size: true, mimeType: true },
        },
        homeworkLogs: { where: { studentId }, select: { day: true, text: true, createdAt: true, updatedAt: true } },
      },
    });
    return rows.map((r) => {
      const d = r.homework ? this.diaryShape(r, joinedDay.get(r.groupId)) : null;
      const from = diaryStart(r.startsAt, r.homeworkSetAt);
      const to = dueKey(r.homeworkDue) ?? from;
      return {
        id: r.id,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        topic: r.topic,
        homework: r.homework,
        homeworkDue: r.homeworkDue,
        group: r.group,
        // Адрес файла ученику не нужен (он закрыт для студентов) — только
        // id для скачивания; ссылки отдаём как есть.
        materials: r.materials.map((m) => ({ ...m, url: m.kind === ClassMaterialKind.LINK ? m.url : null })),
        diary: d
          ? {
              days: d.days,
              logs: d.logs,
              today,
              canWrite: today >= from && today <= to,
              open: today <= to,
            }
          : null,
      };
    });
  }

  /** Успеваемость по каждой группе: уроки со своими отметками, сводка, недели (свои и группы). */
  async cabinetProgress(studentId: string) {
    const memberships = await this.prisma.groupMember.findMany({
      where: { studentId },
      orderBy: { joinedAt: 'asc' },
      select: {
        groupId: true,
        joinedAt: true,
        leftAt: true,
        leftReason: true,
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
    const [sessions, entries] = await Promise.all([
      this.prisma.classSession.findMany({
        where: { groupId: { in: groupIds } },
        select: { ...SESSION_SELECT, groupId: true },
      }),
      this.prisma.journalEntry.findMany({
        where: { session: { groupId: { in: groupIds } } },
        select: ENTRY_SELECT,
      }),
    ]);

    return memberships.map((m) => {
      const gSessions = sessions.filter((s) => s.groupId === m.groupId);
      const ids = new Set(gSessions.map((s) => s.id));
      const gMembers = allMembers.filter((x) => x.groupId === m.groupId);
      const j = buildGroupJournal({
        sessions: gSessions,
        members: gMembers,
        entries: entries.filter((e) => ids.has(e.sessionId)),
      });
      const mine = studentLessons(j, studentId);
      const myWeeks = weekAverages(j, studentId);
      const groupWeeks = groupWeekAverages(
        j,
        gMembers.map((x) => x.studentId),
      );
      return {
        group: m.group,
        active: !m.leftAt,
        completed: m.leftReason === 'COMPLETED',
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        summary: summarize(mine.map((x) => x.mark)),
        lessons: mine
          .filter((x) => x.lesson.past || x.mark)
          .map((x) => ({
            id: x.lesson.id,
            number: x.lesson.number,
            startsAt: x.lesson.startsAt,
            topic: x.lesson.topic,
            mark: x.mark,
          })),
        weeks: j.weeks
          .filter((w) => myWeeks.has(w.key) || groupWeeks.has(w.key))
          .map((w) => ({
            key: w.key,
            index: w.index,
            from: w.from,
            to: w.to,
            me: myWeeks.get(w.key) ?? null,
            groupAvg: groupWeeks.get(w.key) ?? null,
          })),
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
    const path = materialFilePath(m.url);
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
