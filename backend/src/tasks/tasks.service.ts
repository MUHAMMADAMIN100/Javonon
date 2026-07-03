import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isElevated } from '../auth/role-utils';

type CurrentUser = { id: string; role: Role; roles?: Role[] };

// Мульти-исполнители: подтягиваем массив assignees + одиночного controller.
// Legacy assignedTo оставлен на переходный период (мигрирующие клиенты
// ещё могут читать одиночное поле, см. schema.prisma коммент к Task).
const TASK_INCLUDE = {
  assignedTo: { select: { id: true, fullName: true, email: true } },
  assignees: { select: { id: true, fullName: true, email: true } },
  controller: { select: { id: true, fullName: true, email: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
} as const;

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private mail: MailService,
    private realtime: RealtimeGateway,
  ) {}

  // Единая точка рассылки уведомлений по задаче: все исполнители + контролёр
  // (если задан). Дедуплицируем: тот же юзер может быть и исполнителем, и
  // контролёром — уведомляем один раз.
  private async notifyTaskRecipients(
    task: { id: string; title: string },
    recipients: { assigneeIds: string[]; controllerId: string | null },
    kind: 'CREATED' | 'UPDATED',
  ) {
    const ids = Array.from(
      new Set(
        [...recipients.assigneeIds, recipients.controllerId].filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        ),
      ),
    );
    if (!ids.length) return;
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true },
    });
    const type = kind === 'CREATED' ? 'TASK_ASSIGNED' : 'TASK_UPDATED';
    const title = kind === 'CREATED' ? 'Новая задача' : 'Задача обновлена';
    for (const u of users) {
      await this.notifications.notifyUser(u.id, {
        type,
        title,
        message: task.title,
        payload: { taskId: task.id },
      });
    }
    if (kind === 'CREATED') {
      for (const u of users) {
        this.mail
          .send(
            u.email,
            `Новая задача: ${task.title}`,
            `<h2>Вам назначена новая задача</h2>
             <p><b>${task.title}</b></p>
             <p style="color:#666; font-size: 13px">Откройте CRM, чтобы начать выполнение.</p>`,
          )
          .catch(() => undefined);
      }
    }
  }

  async create(dto: CreateTaskDto, user: CurrentUser) {
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT, мульти-роли). Раньше primary
    // ADMIN-only блокировало FOUNDER и любого secondary-ADMIN'а (ТЗ §2).
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Создавать задачи может только администрация');
    }
    const assigneeIds = Array.isArray(dto.assigneeIds) ? dto.assigneeIds : [];
    if (assigneeIds.length === 0) {
      throw new BadRequestException('Нужен хотя бы один исполнитель');
    }
    const controllerId = dto.controllerId ?? null;

    // Проверяем, что все юзеры существуют (assignees + controller).
    const idsToCheck = Array.from(new Set([...assigneeIds, ...(controllerId ? [controllerId] : [])]));
    const foundUsers = await this.prisma.user.findMany({
      where: { id: { in: idsToCheck } },
      select: { id: true },
    });
    if (foundUsers.length !== idsToCheck.length) {
      throw new NotFoundException('Один или несколько сотрудников не найдены');
    }

    const task = await this.prisma.task.create({
      data: {
        title: dto.title.trim(),
        description: dto.description.trim(),
        // Legacy одиночное поле = первый исполнитель для обратной
        // совместимости со старыми запросами/KPI (см. schema.prisma).
        assignedToId: assigneeIds[0],
        // Новый M2M: список исполнителей.
        assignees: { connect: assigneeIds.map((id) => ({ id })) },
        controllerId,
        createdById: user.id,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
      },
      include: TASK_INCLUDE,
    });

    await this.notifyTaskRecipients(
      { id: task.id, title: task.title },
      { assigneeIds, controllerId },
      'CREATED',
    );

    this.realtime.emitStaff('task:new', { task });
    return task;
  }

  async findAll(filters: {
    mine?: boolean;
    currentUserId: string;
    role: Role;
    roles?: Role[];
    search?: string;
    status?: TaskStatus;
    assigneeId?: string;
    controllerId?: string;
  }) {
    // «Все задачи» вместо только своих доступен elevated (FOUNDER/ADMIN/
    // ACCOUNTANT). Принимаем filters.role + extra hint filters.roles чтобы
    // мульти-роли работали (раньше strict role === 'ADMIN').
    const elevated = isElevated({ role: filters.role, roles: filters.roles } as any);

    // «Мои задачи» — юзер исполнитель (M2M assignees) ИЛИ контролёр.
    // Legacy assignedToId включаем как fallback: старые задачи, ещё
    // не мигрировавшие в M2M, всё равно попадут в мой список.
    const mineOr: any[] = [
      { assignees: { some: { id: filters.currentUserId } } },
      { controllerId: filters.currentUserId },
      { assignedToId: filters.currentUserId },
    ];

    const baseWhere: any = elevated && !filters.mine ? {} : { OR: mineOr };

    const extra: any = {};
    if (filters.status) extra.status = filters.status;
    // Явные фильтры доступны только elevated (иначе можно обойти mine-скоуп).
    if (elevated && filters.assigneeId) {
      extra.OR = [
        { assignees: { some: { id: filters.assigneeId } } },
        { assignedToId: filters.assigneeId },
      ];
    }
    if (elevated && filters.controllerId) {
      extra.controllerId = filters.controllerId;
    }

    const search = (filters.search || '').trim();
    const searchWhere = search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : null;

    // AND-склеиваем baseWhere / extra / searchWhere, чтобы разные OR-блоки
    // не затирали друг друга (mine-OR vs assigneeId-OR vs search-OR).
    const andParts = [baseWhere, extra, searchWhere].filter(
      (p) => p && Object.keys(p).length > 0,
    );
    const where = andParts.length ? { AND: andParts } : {};

    return this.prisma.task.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: TASK_INCLUDE,
    });
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    if (!task) throw new NotFoundException('Задача не найдена');
    return task;
  }

  async update(id: string, dto: UpdateTaskDto, user: CurrentUser) {
    const task = await this.findOne(id);
    const currentAssigneeIds = (task as any).assignees?.map((a: any) => a.id) ?? [];
    const isOwner =
      task.assignedToId === user.id || currentAssigneeIds.includes(user.id);
    const isController = task.controllerId === user.id;
    const elevated = isElevated(user as any);
    if (!elevated && !isOwner && !isController) {
      throw new ForbiddenException('Вы не можете редактировать эту задачу');
    }
    // Переназначать задачу/менять контролёра — только elevated (ТЗ §2 мульти-роли).
    if (!elevated && dto.assigneeIds !== undefined) {
      throw new ForbiddenException('Переназначать задачу может только администрация');
    }
    if (!elevated && dto.controllerId !== undefined) {
      throw new ForbiddenException('Менять контролёра может только администрация');
    }

    // Валидация assigneeIds / controllerId: юзеры существуют.
    const idsToCheck: string[] = [];
    if (dto.assigneeIds !== undefined) idsToCheck.push(...dto.assigneeIds);
    if (dto.controllerId !== undefined && dto.controllerId !== null) {
      idsToCheck.push(dto.controllerId);
    }
    if (idsToCheck.length) {
      const uniq = Array.from(new Set(idsToCheck));
      const found = await this.prisma.user.findMany({
        where: { id: { in: uniq } },
        select: { id: true },
      });
      if (found.length !== uniq.length) {
        throw new NotFoundException('Один или несколько сотрудников не найдены');
      }
    }

    const data: any = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.deadline !== undefined
        ? {
            deadline: dto.deadline ? new Date(dto.deadline) : null,
            // Сбрасываем флаги напоминаний — будут отправлены заново при новом дедлайне
            deadlineReminderSent: false,
            overdueNotified: false,
          }
        : {}),
    };
    if (dto.assigneeIds !== undefined) {
      // Синхронизируем M2M через set — Prisma сама удалит лишние связи и добавит новые.
      data.assignees = { set: dto.assigneeIds.map((id) => ({ id })) };
      // Legacy зеркалим на первый в списке (см. schema.prisma коммент).
      data.assignedToId = dto.assigneeIds[0];
    }
    if (dto.controllerId !== undefined) {
      data.controllerId = dto.controllerId; // null допустим — снять контролёра.
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data,
      include: TASK_INCLUDE,
    });

    // Уведомляем всех текущих исполнителей + контролёра (если задан).
    const finalAssigneeIds = (updated as any).assignees?.map((a: any) => a.id) ?? [];
    await this.notifyTaskRecipients(
      { id: updated.id, title: updated.title },
      { assigneeIds: finalAssigneeIds, controllerId: updated.controllerId ?? null },
      'UPDATED',
    );

    this.realtime.emitStaff('task:updated', { task: updated });
    return updated;
  }

  async remove(id: string, user: CurrentUser) {
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Только администратор может удалять задачи');
    }
    await this.findOne(id);
    await this.prisma.task.delete({ where: { id } });
    this.realtime.emitStaff('task:deleted', { id });
    return { ok: true };
  }

  async stats(user: CurrentUser) {
    // Elevated видит статистику по всем; остальные — только по своим
    // (исполнитель по M2M / legacy / контролёр).
    // Раньше `user.role === 'ADMIN'` исключало FOUNDER и secondary-ADMIN.
    const where = isElevated(user as any)
      ? {}
      : {
          OR: [
            { assignees: { some: { id: user.id } } },
            { controllerId: user.id },
            { assignedToId: user.id },
          ],
        };
    const [total, todo, inProgress, done] = await Promise.all([
      this.prisma.task.count({ where }),
      this.prisma.task.count({ where: { ...where, status: TaskStatus.TODO } }),
      this.prisma.task.count({ where: { ...where, status: TaskStatus.IN_PROGRESS } }),
      this.prisma.task.count({ where: { ...where, status: TaskStatus.DONE } }),
    ]);
    return { total, todo, inProgress, done };
  }
}
