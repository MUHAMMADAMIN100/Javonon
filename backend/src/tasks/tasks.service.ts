import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isElevated } from '../auth/role-utils';

type CurrentUser = { id: string; role: Role; roles?: Role[] };

const TASK_INCLUDE = {
  assignedTo: { select: { id: true, fullName: true, email: true } },
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

  async create(dto: CreateTaskDto, user: CurrentUser) {
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT, мульти-роли). Раньше primary
    // ADMIN-only блокировало FOUNDER и любого secondary-ADMIN'а (ТЗ §2).
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Создавать задачи может только администрация');
    }
    const assignee = await this.prisma.user.findUnique({ where: { id: dto.assignedToId } });
    if (!assignee) throw new NotFoundException('Сотрудник не найден');

    const task = await this.prisma.task.create({
      data: {
        title: dto.title.trim(),
        description: dto.description.trim(),
        assignedToId: dto.assignedToId,
        createdById: user.id,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
      },
      include: TASK_INCLUDE,
    });

    // In-app уведомление назначенному сотруднику
    await this.notifications.notifyUser(assignee.id, {
      type: 'TASK_ASSIGNED',
      title: 'Новая задача',
      message: task.title,
      payload: { taskId: task.id },
    });

    // Email сотруднику
    this.mail
      .send(
        assignee.email,
        `Новая задача: ${task.title}`,
        `<h2>Вам назначена новая задача</h2>
         <p><b>${task.title}</b></p>
         <p style="white-space: pre-wrap">${task.description}</p>
         <p style="color:#666; font-size: 13px">Откройте CRM, чтобы начать выполнение.</p>`,
      )
      .catch(() => undefined);

    this.realtime.emitStaff('task:new', { task });
    this.realtime.emitUser(assignee.id, 'notification:new', {
      type: 'TASK_ASSIGNED',
      title: 'Новая задача',
      message: task.title,
    });
    return task;
  }

  async findAll(filters: {
    mine?: boolean;
    currentUserId: string;
    role: Role;
    search?: string;
  }) {
    // «Все задачи» вместо только своих доступен elevated (FOUNDER/ADMIN/
    // ACCOUNTANT). Принимаем filters.role + extra hint filters.roles чтобы
    // мульти-роли работали (раньше strict role === 'ADMIN').
    const elevated = isElevated({ role: filters.role, roles: (filters as any).roles } as any);
    const baseWhere: any =
      elevated && !filters.mine
        ? {}
        : { assignedToId: filters.currentUserId };
    const search = (filters.search || '').trim();
    const where = search
      ? {
          ...baseWhere,
          OR: [
            { title: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : baseWhere;
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
    const isOwner = task.assignedToId === user.id;
    const elevated = isElevated(user as any);
    if (!elevated && !isOwner) {
      throw new ForbiddenException('Вы не можете редактировать эту задачу');
    }
    // Переназначать задачу — только elevated (ТЗ §2 мульти-роли).
    if (!elevated && dto.assignedToId !== undefined) {
      throw new ForbiddenException('Переназначать задачу может только администрация');
    }
    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.assignedToId !== undefined ? { assignedToId: dto.assignedToId } : {}),
        ...(dto.deadline !== undefined ? {
          deadline: dto.deadline ? new Date(dto.deadline) : null,
          // Сбрасываем флаги напоминаний — будут отправлены заново при новом дедлайне
          deadlineReminderSent: false,
          overdueNotified: false,
        } : {}),
      },
      include: TASK_INCLUDE,
    });
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
    // Elevated видит статистику по всем; остальные — только по своим.
    // Раньше `user.role === 'ADMIN'` исключало FOUNDER и secondary-ADMIN.
    const where = isElevated(user as any) ? {} : { assignedToId: user.id };
    const [total, todo, inProgress, done] = await Promise.all([
      this.prisma.task.count({ where }),
      this.prisma.task.count({ where: { ...where, status: TaskStatus.TODO } }),
      this.prisma.task.count({ where: { ...where, status: TaskStatus.IN_PROGRESS } }),
      this.prisma.task.count({ where: { ...where, status: TaskStatus.DONE } }),
    ]);
    return { total, todo, inProgress, done };
  }
}
