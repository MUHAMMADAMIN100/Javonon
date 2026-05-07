import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ChatRoomType } from '@prisma/client';

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService, private realtime: RealtimeGateway) {}

  /** Гарантирует, что общий чат компании существует, и возвращает его. */
  async ensureGeneralRoom() {
    let room = await this.prisma.chatRoom.findFirst({ where: { type: 'GENERAL' } });
    if (!room) {
      room = await this.prisma.chatRoom.create({
        data: { type: 'GENERAL', title: 'Команда Javonon' },
      });
    }
    // Каждый сотрудник автоматически в общем чате
    const allUsers = await this.prisma.user.findMany({ select: { id: true } });
    const existingMemberships = await this.prisma.chatMember.findMany({
      where: { roomId: room.id },
      select: { userId: true },
    });
    const existingIds = new Set(existingMemberships.map((m) => m.userId));
    const toAdd = allUsers.filter((u) => !existingIds.has(u.id));
    if (toAdd.length) {
      await this.prisma.chatMember.createMany({
        data: toAdd.map((u) => ({ roomId: room!.id, userId: u.id })),
      });
    }
    return room;
  }

  async listRooms(userId: string) {
    await this.ensureGeneralRoom();
    return this.prisma.chatRoom.findMany({
      where: { members: { some: { userId } } },
      orderBy: { updatedAt: 'desc' },
      include: {
        members: {
          include: { user: { select: { id: true, fullName: true, role: true } } },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { author: { select: { id: true, fullName: true } } },
        },
      },
    });
  }

  async getRoom(roomId: string, userId: string) {
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) throw new NotFoundException('Чат не найден или вы не участник');

    const messages = await this.prisma.chatMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { id: true, fullName: true, role: true } } },
      take: 200,
    });
    // Mark as read
    await this.prisma.chatMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { lastReadAt: new Date() },
    });
    return { messages };
  }

  async sendMessage(roomId: string, authorId: string, text: string, mentionsIds: string[] = []) {
    const trimmed = (text || '').trim();
    if (!trimmed) throw new BadRequestException('Пустое сообщение');
    if (trimmed.length > 4000) throw new BadRequestException('Слишком длинное сообщение');

    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId: authorId } },
    });
    if (!member) throw new NotFoundException('Чат не найден');

    const msg = await this.prisma.chatMessage.create({
      data: { roomId, authorId, text: trimmed, mentionsIds },
      include: { author: { select: { id: true, fullName: true, role: true } } },
    });
    await this.prisma.chatRoom.update({
      where: { id: roomId },
      data: { updatedAt: new Date() },
    });

    // Realtime broadcast в соответствующую комнату
    this.realtime.emitStaff('chat:message', { roomId, message: msg });
    return msg;
  }

  async createTeamRoom(creatorId: string, title: string, memberIds: string[]) {
    const ids = Array.from(new Set([creatorId, ...memberIds]));
    const room = await this.prisma.chatRoom.create({
      data: {
        type: ChatRoomType.TEAM,
        title: title.trim() || 'Команда',
        members: { create: ids.map((id) => ({ userId: id })) },
      },
      include: {
        members: { include: { user: { select: { id: true, fullName: true, role: true } } } },
      },
    });
    this.realtime.emitStaff('chat:room', { room });
    return room;
  }

  async createDirectRoom(creatorId: string, otherUserId: string) {
    if (creatorId === otherUserId) throw new BadRequestException('Нельзя создать чат с самим собой');
    // Найти существующий direct
    const existing = await this.prisma.chatRoom.findFirst({
      where: {
        type: 'DIRECT',
        AND: [
          { members: { some: { userId: creatorId } } },
          { members: { some: { userId: otherUserId } } },
        ],
      },
      include: { members: { include: { user: { select: { id: true, fullName: true, role: true } } } } },
    });
    if (existing) return existing;

    const otherUser = await this.prisma.user.findUnique({
      where: { id: otherUserId },
      select: { fullName: true },
    });
    return this.prisma.chatRoom.create({
      data: {
        type: 'DIRECT',
        title: otherUser?.fullName || 'Прямой чат',
        members: { create: [{ userId: creatorId }, { userId: otherUserId }] },
      },
      include: { members: { include: { user: { select: { id: true, fullName: true, role: true } } } } },
    });
  }

  async unreadCounts(userId: string) {
    const memberships = await this.prisma.chatMember.findMany({
      where: { userId },
      include: {
        room: {
          include: {
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { createdAt: true, authorId: true },
            },
          },
        },
      },
    });
    return memberships.map((m) => {
      const last = m.room.messages[0];
      const unread = last && last.authorId !== userId &&
        (!m.lastReadAt || last.createdAt > m.lastReadAt) ? 1 : 0;
      return { roomId: m.roomId, unread };
    });
  }
}
