import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApplicationStatus, Direction, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { ActivityService } from '../activity/activity.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { REQUIRED_DOCUMENT_TYPES } from '../common/documents';

const CABINET_BY_DIRECTION: Record<Direction, number> = {
  BACHELOR: 1,
  MASTER: 2,
  LANGUAGE: 3,
  LANGUAGE_COLLEGE: 4,
  LANGUAGE_BACHELOR: 5,
  COLLEGE: 6,
};

const DIRECTION_LABEL: Record<Direction, string> = {
  BACHELOR: 'Бакалавриат',
  MASTER: 'Магистратура',
  LANGUAGE: 'Языковые курсы',
  LANGUAGE_COLLEGE: 'Языковой + колледж',
  LANGUAGE_BACHELOR: 'Языковой + бакалавриат',
  COLLEGE: 'Колледж',
};

const MANAGER_INCLUDE = {
  student: {
    include: {
      manager: { select: { id: true, fullName: true, email: true } },
      chinaManager: { select: { id: true, fullName: true, email: true } },
      program: true,
    },
  },
  manager: { select: { id: true, fullName: true, email: true } },
  chinaManager: { select: { id: true, fullName: true, email: true } },
  program: true,
};

type CurrentUser = { id: string; role: Role };

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private telegram: TelegramService,
    private mail: MailService,
    private sms: SmsService,
    private activity: ActivityService,
    private realtime: RealtimeGateway,
  ) {}

  // Порядок этапов воронки — для определения, "понизили" или "продвинули" заявку
  private static STAGE_ORDER: ApplicationStatus[] = [
    'NEW',
    'DOCS_REVIEW',
    'DOCS_SUBMITTED',
    'PRE_ADMISSION',
    'AWAITING_PAYMENT',
    'ENROLLED',
  ];

  private isDowngrade(prev: ApplicationStatus, next: ApplicationStatus): boolean {
    const a = ApplicationsService.STAGE_ORDER.indexOf(prev);
    const b = ApplicationsService.STAGE_ORDER.indexOf(next);
    return a >= 0 && b >= 0 && b < a;
  }

  private smsTextForStatus(prev: ApplicationStatus, next: ApplicationStatus): string {
    const labelNext = ApplicationsService.STATUS_LABEL[next] || next;
    const labelPrev = ApplicationsService.STATUS_LABEL[prev] || prev;
    if (next === 'ENROLLED') {
      return `🎉 Javonon: Поздравляем! Вы зачислены. Подробности в личном кабинете.`;
    }
    if (this.isDowngrade(prev, next)) {
      return `Javonon: Заявка возвращена с «${labelPrev}» на «${labelNext}». Свяжитесь с менеджером для уточнений.`;
    }
    return `Javonon: Статус Вашей заявки изменён: «${labelPrev}» → «${labelNext}».`;
  }

  /** Возвращает первый непустой номер телефона: из заявки, потом из связанного студента. */
  private async resolvePhone(app: { phone: string | null; studentId?: string | null }): Promise<string | null> {
    if (app.phone && app.phone.trim()) return app.phone.trim();
    if (app.studentId) {
      const s = await this.prisma.student.findUnique({
        where: { id: app.studentId },
        select: { phones: true },
      });
      const first = s?.phones?.[0];
      if (first && first.trim()) return first.trim();
    }
    return null;
  }

  private static STATUS_LABEL: Record<ApplicationStatus, string> = {
    NEW: 'Новая заявка',
    IN_PROGRESS: 'В работе',
    COMPLETED: 'Завершена',
    DOCS_REVIEW: 'Документы на проверке',
    DOCS_SUBMITTED: 'Документы поданы',
    PRE_ADMISSION: 'Предварительное зачисление',
    AWAITING_PAYMENT: 'Ожидание оплаты',
    ENROLLED: 'Зачислен',
  };

  async create(dto: CreateApplicationDto & { ref?: string }) {
    const app = await this.prisma.application.create({
      data: {
        fullName: dto.fullName.trim(),
        phone: dto.phone.trim(),
        email: dto.email?.trim() || null,
        direction: dto.direction,
        comment: dto.comment?.trim() || null,
        programId: dto.programId || null,
        source: dto.source || 'LANDING_FORM',
      },
    });

    // Реферальная атрибуция: если в заявке пришёл ref-код партнёра,
    // привязываем заявку к нему через ReferralsService (если доступен).
    // Импорт сервиса опциональный — не ломаем сборку если модуль ещё не
    // подключён в конкретной конфигурации.
    if (dto.ref && (this as any).referrals?.attribute) {
      (this as any).referrals.attribute({
        code: dto.ref,
        source: 'SITE',
        applicationId: app.id,
        emailHint: app.email || undefined,
      }).catch(() => undefined);
    }

    await this.notifications.notifyAllStaff({
      type: 'APPLICATION_NEW',
      title: 'Новая заявка',
      message: `${app.fullName} — ${DIRECTION_LABEL[app.direction]}, ${app.phone}`,
      payload: { applicationId: app.id },
    });

    const tgText =
      `🆕 *Новая заявка Javonon*\n` +
      `*ФИО:* ${app.fullName}\n` +
      `*Телефон:* ${app.phone}\n` +
      (app.email ? `*Email:* ${app.email}\n` : '') +
      `*Направление:* ${DIRECTION_LABEL[app.direction]}\n` +
      (app.comment ? `*Комментарий:* ${app.comment}` : '');
    this.telegram.send(tgText).catch(() => undefined);

    this.mail
      .sendToAdmin(
        `Новая заявка: ${app.fullName}`,
        `<h2>Новая заявка с лендинга</h2>
         <p><b>ФИО:</b> ${app.fullName}</p>
         <p><b>Телефон:</b> ${app.phone}</p>
         ${app.email ? `<p><b>Email:</b> ${app.email}</p>` : ''}
         <p><b>Направление:</b> ${DIRECTION_LABEL[app.direction]}</p>
         ${app.comment ? `<p><b>Комментарий:</b> ${app.comment}</p>` : ''}`,
      )
      .catch(() => undefined);

    // SMS студенту: подтверждение получения заявки
    this.sms
      .send(
        app.phone,
        `Javonon: Ваша заявка получена. Менеджер свяжется с Вами в ближайшее время.`,
      )
      .catch(() => undefined);

    this.realtime.emitStaff('application:new', { application: app });
    return app;
  }

  async findAll(filters: {
    status?: ApplicationStatus;
    direction?: Direction;
    search?: string;
    mine?: boolean;
    managerUserId?: string;
    currentUserId?: string;
    currentUserRole?: Role;
  }) {
    const where: Prisma.ApplicationWhereInput = {};
    const and: Prisma.ApplicationWhereInput[] = [];
    if (filters.status) where.status = filters.status;
    if (filters.direction) where.direction = filters.direction;
    // EMPLOYEE всегда видит только свои заявки (даже если mine=false на фронте).
    const restrictToMine =
      (filters.mine && filters.currentUserId) ||
      (filters.currentUserRole === 'EMPLOYEE' && filters.currentUserId);
    if (restrictToMine) {
      and.push({
        OR: [
          { managerId: filters.currentUserId },
          { chinaManagerId: filters.currentUserId },
        ],
      });
    }
    // Фильтр по конкретному менеджеру: показываем заявки где он
    // назначен либо локальным, либо китайским менеджером.
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
          { phone: { contains: filters.search, mode: 'insensitive' } },
          { email: { contains: filters.search, mode: 'insensitive' } },
        ],
      });
    }
    if (and.length) where.AND = and;
    return this.prisma.application.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: MANAGER_INCLUDE,
    });
  }

  async findOne(id: string) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: MANAGER_INCLUDE,
    });
    if (!app) throw new NotFoundException('Заявка не найдена');
    return app;
  }

  private ensureCanEdit(
    app: { managerId: string | null; chinaManagerId?: string | null },
    user: CurrentUser,
  ) {
    if (user.role === 'ADMIN') return;
    const assigned = app.managerId || app.chinaManagerId;
    if (!assigned) return; // ещё не назначен — любой может взять в работу
    if (app.managerId === user.id || app.chinaManagerId === user.id) return;
    throw new ForbiddenException(
      'Только назначенные менеджеры или администратор могут редактировать эту заявку',
    );
  }

  async update(id: string, dto: UpdateApplicationDto, user: CurrentUser) {
    const existing = await this.findOne(id);
    this.ensureCanEdit(existing, user);

    // Авто-создание студента при переходе NEW → DOCS_REVIEW (если ещё не создан)
    if (
      dto.status === ApplicationStatus.DOCS_REVIEW &&
      existing.status === ApplicationStatus.NEW &&
      !existing.studentId
    ) {
      // Создаём студента только если email уникален (он обязателен для ЛК)
      // Старый флоу (без email) — пропускаем, студент создастся при отдельном действии
      let studentId = existing.studentId;
      try {
        const studentData: any = {
          fullName: existing.fullName,
          phones: [existing.phone],
          email: existing.email,
          direction: existing.direction,
          cabinet: CABINET_BY_DIRECTION[existing.direction],
          comment: existing.comment,
        };
        const student = await this.prisma.student.create({ data: studentData });
        studentId = student.id;
      } catch {
        // Если студент с таким email уже есть — просто переводим статус без создания
      }
      const updated = await this.prisma.application.update({
        where: { id },
        data: { ...dto, ...(studentId ? { studentId } : {}) },
        include: MANAGER_INCLUDE,
      });
      this.realtime.emitStaff('application:updated', { application: updated });
      if (updated.studentId) {
        this.realtime.emitStudent(updated.studentId, 'student:updated', { studentId: updated.studentId });
      }
      // SMS студенту: статус изменился на «Документы на проверке»
      const text = this.smsTextForStatus(existing.status, ApplicationStatus.DOCS_REVIEW);
      this.resolvePhone(updated).then((phone) => {
        if (phone) this.sms.send(phone, text).catch(() => undefined);
      }).catch(() => undefined);

      // ActivityLog
      this.activity
        .log({
          actorId: user.id,
          actorName: '',
          actorRole: user.role,
          action: 'STATUS_CHANGE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details: `Статус: ${existing.status} → ${updated.status}`,
        })
        .catch(() => undefined);
      return updated;
    }

    // Гейт DOCS_SUBMITTED удалён по запросу: менеджер должен иметь возможность
    // переводить заявку на следующий этап даже если не все документы загружены
    // (документы могут быть переданы по другим каналам, или клиент просит
    // двигаться дальше). Список недостающих документов всё ещё доступен для
    // справки через `missingRequiredDocs` и UI-предупреждение в CRM.

    const updated = await this.prisma.application.update({
      where: { id },
      data: dto,
      include: MANAGER_INCLUDE,
    });
    this.realtime.emitStaff('application:updated', { application: updated });
    if (updated.studentId) {
      this.realtime.emitStudent(updated.studentId, 'student:updated', { studentId: updated.studentId });
      this.realtime.emitStudent(updated.studentId, 'application:updated', { application: updated });
    }

    // SMS студенту при ЛЮБОЙ смене статуса (вперёд/назад/на ENROLLED)
    if (dto.status && dto.status !== existing.status) {
      const text = this.smsTextForStatus(existing.status, dto.status);
      this.resolvePhone(updated).then((phone) => {
        if (phone) this.sms.send(phone, text).catch(() => undefined);
      }).catch(() => undefined);
    }

    // ActivityLog для смены статуса
    if (dto.status && dto.status !== existing.status) {
      this.activity
        .log({
          actorId: user.id,
          actorName: '',
          actorRole: user.role,
          action: 'STATUS_CHANGE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details: `Статус: ${existing.status} → ${dto.status}`,
        })
        .catch(() => undefined);
    }

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
    const existing = await this.findOne(id);

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

    // Синхронизируем менеджеров на связанном студенте
    if (existing.studentId && Object.keys(data).length > 0) {
      await this.prisma.student.update({
        where: { id: existing.studentId },
        data,
      });
    }

    const updated = await this.prisma.application.update({
      where: { id },
      data,
      include: MANAGER_INCLUDE,
    });
    this.realtime.emitStaff('application:updated', { application: updated });
    if (updated.studentId) {
      this.realtime.emitStudent(updated.studentId, 'student:updated', { studentId: updated.studentId });
    }

    // ActivityLog + уведомление о смене менеджера
    const beforeManager = existing.manager?.fullName || '—';
    const afterManager = updated.manager?.fullName || '—';
    const beforeChina = existing.chinaManager?.fullName || '—';
    const afterChina = updated.chinaManager?.fullName || '—';
    const detailsParts: string[] = [];
    if (patch.managerId !== undefined && existing.managerId !== updated.managerId) {
      detailsParts.push(`Менеджер 🇹🇯: ${beforeManager} → ${afterManager}`);
    }
    if (patch.chinaManagerId !== undefined && existing.chinaManagerId !== updated.chinaManagerId) {
      detailsParts.push(`Менеджер 🇨🇳: ${beforeChina} → ${afterChina}`);
    }
    if (detailsParts.length > 0) {
      const details = detailsParts.join('; ');
      this.activity
        .log({
          actorId: user.id,
          actorRole: user.role,
          action: 'MANAGER_CHANGE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details,
        })
        .catch(() => undefined);

      // Уведомления staff (всем) о переназначении
      this.notifications
        .notifyAllStaff({
          type: 'MANAGER_CHANGE',
          title: 'Менеджер изменён',
          message: `${updated.fullName}: ${details}`,
          payload: { applicationId: updated.id, studentId: updated.studentId },
        })
        .catch(() => undefined);
    }

    return updated;
  }

  private async missingRequiredDocs(studentId: string): Promise<string[]> {
    const docs = await this.prisma.document.findMany({
      where: { studentId },
      select: { type: true },
    });
    const uploaded = new Set(docs.map((d) => d.type));
    return REQUIRED_DOCUMENT_TYPES.filter((t) => !uploaded.has(t.type)).map((t) => t.label);
  }

  async remove(id: string, user: CurrentUser) {
    // QA-fix: удалять заявки (вместе со студентом) может только ADMIN.
    // EMPLOYEE без назначения раньше мог удалить любую неназначенную заявку.
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Удалять заявки может только администратор');
    }
    const app = await this.findOne(id);
    if (app.studentId) {
      await this.prisma.student.delete({ where: { id: app.studentId } }).catch(() => undefined);
    }
    await this.prisma.application.delete({ where: { id } }).catch(() => undefined);
    this.realtime.emitStaff('application:deleted', { id });
    return { ok: true };
  }

  async stats(user?: { id: string; role: Role }) {
    // EMPLOYEE видит только свои заявки (где он либо локальный, либо китайский менеджер).
    // ADMIN — все заявки.
    const where: Prisma.ApplicationWhereInput | undefined =
      user && user.role === 'EMPLOYEE'
        ? { OR: [{ managerId: user.id }, { chinaManagerId: user.id }] }
        : undefined;
    const [total, byStatus, byDirection] = await Promise.all([
      this.prisma.application.count({ where }),
      this.prisma.application.groupBy({ by: ['status'], _count: true, where }),
      this.prisma.application.groupBy({ by: ['direction'], _count: true, where }),
    ]);
    return { total, byStatus, byDirection };
  }
}
