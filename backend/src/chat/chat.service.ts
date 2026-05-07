import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { AiService } from '../ai/ai.service';
import { FinanceService } from '../finance/finance.service';
import { ChatRoomType } from '@prisma/client';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private notifications: NotificationsService,
    private ai: AiService,
    private finance: FinanceService,
  ) {}

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

    // Парсим @mentions (форматы: @full-name, @ID, @firstname.lastname)
    let resolvedMentions = mentionsIds.length ? mentionsIds : await this.resolveMentionsFromText(trimmed);
    resolvedMentions = Array.from(new Set(resolvedMentions)).filter((id) => id !== authorId);

    const author = await this.prisma.user.findUnique({
      where: { id: authorId },
      select: { fullName: true },
    });

    const msg = await this.prisma.chatMessage.create({
      data: { roomId, authorId, text: trimmed, mentionsIds: resolvedMentions },
      include: { author: { select: { id: true, fullName: true, role: true } } },
    });
    await this.prisma.chatRoom.update({
      where: { id: roomId },
      data: { updatedAt: new Date() },
    });

    // Уведомляем упомянутых
    for (const mid of resolvedMentions) {
      await this.notifications.notifyUser(mid, {
        type: 'CHAT_MENTION',
        title: `💬 Вас упомянул ${author?.fullName || 'кто-то'}`,
        message: trimmed.slice(0, 140),
        payload: { roomId, messageId: msg.id, authorId },
      });
    }

    // Realtime broadcast
    this.realtime.emitStaff('chat:message', { roomId, message: msg });

    // AI-обработка: если в сообщении есть команда «добавь расход / доход / потратил / оплатил»
    // — парсим и сами создаём транзакцию + ответ от бота.
    await this.tryAiAction(roomId, authorId, trimmed);

    return msg;
  }

  /**
   * Резолв @mentions: парсим из текста все @<word> и пробуем найти соответствующего юзера.
   * Поддерживает: @id, @firstname-lastname, @firstname (если уникален).
   */
  private async resolveMentionsFromText(text: string): Promise<string[]> {
    const matches = text.match(/@([\wа-яА-ЯёЁ.\-]+)/g);
    if (!matches?.length) return [];
    const users = await this.prisma.user.findMany({
      select: { id: true, fullName: true, email: true },
    });
    const found = new Set<string>();
    for (const raw of matches) {
      const handle = raw.slice(1).toLowerCase();
      const user = users.find((u) => {
        const name = u.fullName.toLowerCase().replace(/\s+/g, '-');
        const email = u.email.toLowerCase().split('@')[0];
        return u.id === handle || name === handle || name.startsWith(handle) || email === handle;
      });
      if (user) found.add(user.id);
    }
    return Array.from(found);
  }

  /**
   * AI bot: если сообщение содержит ключевые слова про деньги — пытаемся
   * парсить через AiService и при успехе создать транзакцию.
   * Доступно только для ADMIN/ACCOUNTANT.
   */
  private async tryAiAction(roomId: string, authorId: string, text: string) {
    const lower = text.toLowerCase();
    const isFinancial = /добавь\s+(расход|доход)|потрат|оплат|приш(ло|ёл)|поступ/i.test(lower);
    if (!isFinancial) return;

    const author = await this.prisma.user.findUnique({
      where: { id: authorId },
      select: { role: true, fullName: true },
    });
    if (!author || (author.role !== 'ADMIN' && author.role !== 'ACCOUNTANT')) {
      // Не имеет прав — игнорируем (не отвечаем, чтоб не спамить)
      return;
    }

    const parsed = await this.ai.parseTransaction(text);
    if (!parsed) {
      await this.systemBotMessage(roomId,
        `🤖 Не понял команду. Попробуй: «добавь расход 200$ аренда» или «студент оплатил 1500$ обучение».`,
      );
      return;
    }

    const transaction = await this.finance.create(
      {
        type: parsed.type,
        category: parsed.category,
        amount: parsed.amount,
        currency: parsed.currency,
        comment: parsed.comment,
      },
      authorId,
    );

    const sign = transaction.type === 'INCOME' ? '+' : '−';
    await this.systemBotMessage(roomId,
      `🤖 Записал: ${sign}${transaction.amount} ${transaction.currency} · ${parsed.comment || parsed.category}`,
    );
  }

  /** Создаёт сообщение от системного бота (без author, помечается особым образом). */
  private async systemBotMessage(roomId: string, text: string) {
    // Bot-сообщения пишутся от первого ADMIN-юзера (или любого админа), чтобы Foreign Key не падал
    const admin = await this.prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) return;
    const msg = await this.prisma.chatMessage.create({
      data: {
        roomId,
        authorId: admin.id,
        text,
        // Префикс mentionsIds = ['__BOT__'] — фронт распознаёт и рисует как бот-сообщение
        mentionsIds: ['__BOT__'],
      },
      include: { author: { select: { id: true, fullName: true, role: true } } },
    });
    this.realtime.emitStaff('chat:message', { roomId, message: msg });
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
