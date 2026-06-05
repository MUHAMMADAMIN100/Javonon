import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

interface NotifyPayload {
  type: string;
  title: string;
  message: string;
  payload?: any;
}

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService, private realtime: RealtimeGateway) {}

  async notifyAllStaff(data: NotifyPayload) {
    const users = await this.prisma.user.findMany({ select: { id: true } });
    if (!users.length) return;
    await this.prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id,
        type: data.type,
        title: data.title,
        message: data.message,
        payload: data.payload ?? undefined,
      })),
    });
    // Realtime — всем сотрудникам
    this.realtime.emitStaff('notification:new', {
      type: data.type,
      title: data.title,
      message: data.message,
      payload: data.payload,
    });
  }

  async notifyAdmins(data: NotifyPayload) {
    // Мульти-роли (ТЗ §2): включает юзеров с ADMIN в roles[]. По ТЗ
    // ADMIN и ACCOUNTANT эквивалентны, поэтому уведомления админам
    // расширяем и на ACCOUNTANT — иначе мульти-роль не симметрична.
    const admins = await this.prisma.user.findMany({
      where: {
        OR: [
          { role: { in: ['ADMIN', 'ACCOUNTANT'] } },
          { roles: { hasSome: ['ADMIN', 'ACCOUNTANT'] } },
        ],
      },
      select: { id: true },
    });
    if (!admins.length) return;
    await this.prisma.notification.createMany({
      data: admins.map((u) => ({
        userId: u.id,
        type: data.type,
        title: data.title,
        message: data.message,
        payload: data.payload ?? undefined,
      })),
    });
    for (const u of admins) {
      this.realtime.emitUser(u.id, 'notification:new', {
        type: data.type,
        title: data.title,
        message: data.message,
        payload: data.payload,
      });
    }
  }

  async notifyUser(userId: string, data: NotifyPayload) {
    const notif = await this.prisma.notification.create({
      data: {
        userId,
        type: data.type,
        title: data.title,
        message: data.message,
        payload: data.payload ?? undefined,
      },
    });
    this.realtime.emitUser(userId, 'notification:new', {
      id: notif.id,
      type: data.type,
      title: data.title,
      message: data.message,
      payload: data.payload,
    });
    return notif;
  }

  async listForUser(userId: string, onlyUnread = false) {
    return this.prisma.notification.findMany({
      where: {
        userId,
        ...(onlyUnread ? { read: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }
}
