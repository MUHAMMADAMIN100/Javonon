import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { AiService } from '../ai/ai.service';
import { FinanceService } from '../finance/finance.service';
import { ChatRoomType } from '@prisma/client';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
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

    // QA-fix: раньше брали 200 СТАРЕЙШИХ (orderBy asc + take 200),
    // и в чатах с историей >200 сообщений пользователь видел древнюю переписку
    // вместо последних. Теперь берём 200 ПОСЛЕДНИХ и переворачиваем для UI (asc).
    const recent = await this.prisma.chatMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      include: {
        author: { select: { id: true, fullName: true, role: true } },
        replyTo: {
          select: {
            id: true, text: true, authorId: true, attachments: true, deletedAt: true,
            author: { select: { id: true, fullName: true } },
          },
        },
        reactions: { select: { id: true, emoji: true, userId: true } },
      },
      take: 200,
    });
    const messages = recent.reverse();
    // Mark as read + emit для собеседника чтобы у него галочки стали ✓✓ сразу.
    const lastReadAt = new Date();
    await this.prisma.chatMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { lastReadAt },
    });
    this.realtime.emitStaff('chat:read', { roomId, userId, lastReadAt: lastReadAt.toISOString() });
    return { messages };
  }

  /** Telegram-style: пометить как прочитано (повторно, при scroll/focus). */
  async markRoomRead(roomId: string, userId: string) {
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) throw new NotFoundException('Чат не найден');
    const lastReadAt = new Date();
    await this.prisma.chatMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { lastReadAt },
    });
    this.realtime.emitStaff('chat:read', { roomId, userId, lastReadAt: lastReadAt.toISOString() });
    return { ok: true, lastReadAt: lastReadAt.toISOString() };
  }

  async sendMessage(
    roomId: string,
    authorId: string,
    text: string,
    mentionsIds: string[] = [],
    options: { replyToId?: string; attachments?: any[] } = {},
  ) {
    const trimmed = (text || '').trim();
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    // Сообщение может быть только из вложений (без текста) или только текст.
    if (!trimmed && !hasAttachments) throw new BadRequestException('Пустое сообщение');
    if (trimmed.length > 4000) throw new BadRequestException('Слишком длинное сообщение');

    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId: authorId } },
    });
    if (!member) throw new NotFoundException('Чат не найден');

    // Validate replyToId — должен быть из этой же комнаты.
    if (options.replyToId) {
      const orig = await this.prisma.chatMessage.findUnique({
        where: { id: options.replyToId },
        select: { roomId: true },
      });
      if (!orig || orig.roomId !== roomId) {
        throw new BadRequestException('Невозможно ответить: исходное сообщение не найдено');
      }
    }

    // Парсим @mentions (форматы: @full-name, @ID, @firstname.lastname)
    let resolvedMentions = mentionsIds.length ? mentionsIds : await this.resolveMentionsFromText(trimmed);
    resolvedMentions = Array.from(new Set(resolvedMentions)).filter((id) => id !== authorId);
    // QA-fix #36: фильтруем mentionsIds по реально существующим юзерам —
    // раньше fake-id давал FK-500 при notifications.notifyUser.
    if (resolvedMentions.length) {
      const realUsers = await this.prisma.user.findMany({
        where: { id: { in: resolvedMentions } },
        select: { id: true },
      });
      const realIds = new Set(realUsers.map((u) => u.id));
      resolvedMentions = resolvedMentions.filter((id) => realIds.has(id));
    }

    const author = await this.prisma.user.findUnique({
      where: { id: authorId },
      select: { fullName: true },
    });

    // Создаём сообщение с минимальным include — author + replyTo + reactions.
    // reactions всегда пустой для нового сообщения, но Prisma требует include
    // если фронт ожидает поле в результате (для типизации).
    const msg = await this.prisma.chatMessage.create({
      data: {
        roomId,
        authorId,
        text: trimmed,
        mentionsIds: resolvedMentions,
        replyToId: options.replyToId || null,
        attachments: hasAttachments ? (options.attachments as any) : undefined,
      },
      include: {
        author: { select: { id: true, fullName: true, role: true } },
        replyTo: {
          select: {
            id: true, text: true, authorId: true, attachments: true,
            author: { select: { id: true, fullName: true } },
          },
        },
        reactions: { select: { id: true, emoji: true, userId: true } },
      },
    });

    // КРИТИЧНО ДЛЯ СКОРОСТИ: сначала broadcast — собеседник видит сообщение
    // мгновенно. Потом параллельно: room.updatedAt + уведомления.
    this.realtime.emitStaff('chat:message', { roomId, message: msg });

    // Всё остальное — fire-and-forget в фоне, без await чтобы не задерживать
    // ответ автору и не мешать broadcast'у.
    this.afterSendBackground(msg, roomId, authorId, trimmed, resolvedMentions, author?.fullName).catch(
      (err) => this.logger.error(`afterSendBackground failed: ${err?.message}`),
    );

    return msg;
  }

  /** Фоновая работа после emit'а: room update + notifications + AI parse. */
  private async afterSendBackground(
    msg: { id: string },
    roomId: string,
    authorId: string,
    trimmed: string,
    resolvedMentions: string[],
    authorName?: string,
  ) {
    // 1) bump room updatedAt — не блокирует доставку
    await this.prisma.chatRoom.update({
      where: { id: roomId },
      data: { updatedAt: new Date() },
    });

    // 2) Notifications + AI — параллельно
    const mentionedSet = new Set(resolvedMentions);
    const [allMembers, room] = await Promise.all([
      this.prisma.chatMember.findMany({ where: { roomId }, select: { userId: true } }),
      this.prisma.chatRoom.findUnique({ where: { id: roomId }, select: { type: true, title: true } }),
    ]);
    const roomLabel = room?.type === 'GENERAL'
      ? 'Команда Javonon'
      : room?.type === 'TEAM'
        ? room.title || 'Команда'
        : authorName || 'Чат';

    // Все notifications в параллель — Promise.all вместо for-await.
    const tasks: Promise<unknown>[] = [];
    for (const mid of resolvedMentions) {
      tasks.push(this.notifications.notifyUser(mid, {
        type: 'CHAT_MENTION',
        title: `💬 Вас упомянул ${authorName || 'кто-то'}`,
        message: trimmed.slice(0, 140),
        payload: { roomId, messageId: msg.id, authorId },
      }));
    }
    for (const m of allMembers) {
      if (m.userId === authorId) continue;
      if (mentionedSet.has(m.userId)) continue;
      tasks.push(this.notifications.notifyUser(m.userId, {
        type: 'CHAT_MESSAGE',
        title: `${authorName || 'Кто-то'} · ${roomLabel}`,
        message: trimmed.slice(0, 140),
        payload: { roomId, messageId: msg.id, authorId },
      }));
    }
    await Promise.all(tasks);

    // AI-обработка: если в сообщении есть команда «добавь расход» — парсим.
    await this.tryAiAction(roomId, authorId, trimmed);
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
    // QA-fix #15: триггер не ловил «запиши доход/расход», «сохрани доход».
    // Расширяем глаголы — теперь любая команда добавления учитывается.
    const isFinancial = /(добавь|запиши|сохрани|укажи)\s+(расход|доход)|потрат|оплат|приш(ло|ёл)|поступ/i.test(lower);
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
    // QA-fix: валидируем все memberId, чтобы вместо FK-500 пользователь получал 400.
    const existing = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (existing.length !== ids.length) {
      throw new BadRequestException('Один или несколько участников не найдены');
    }
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
    if (!otherUserId) throw new BadRequestException('Не указан собеседник');
    if (creatorId === otherUserId) throw new BadRequestException('Нельзя создать чат с самим собой');
    const otherUser = await this.prisma.user.findUnique({
      where: { id: otherUserId },
      select: { id: true, fullName: true },
    });
    if (!otherUser) throw new NotFoundException('Пользователь не найден');

    const includeAll = {
      members: { include: { user: { select: { id: true, fullName: true, role: true } } } },
    };

    // QA-fix #6: атомарный find-or-create в $transaction. Раньше при двух
    // параллельных запросах (например клик дважды на "+ собеседник")
    // findFirst возвращал null обоим, и создавались ДВА direct-room для
    // одной пары — список чатов наполнялся дублями.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.chatRoom.findFirst({
        where: {
          type: 'DIRECT',
          AND: [
            { members: { some: { userId: creatorId } } },
            { members: { some: { userId: otherUserId } } },
          ],
        },
        include: includeAll,
      });
      if (existing) return existing;
      return tx.chatRoom.create({
        data: {
          type: 'DIRECT',
          title: otherUser.fullName || 'Прямой чат',
          members: { create: [{ userId: creatorId }, { userId: otherUserId }] },
        },
        include: includeAll,
      });
    });
  }

  /** QA-fix #6: одноразовая зачистка существующих дублей direct-room.
   * Группируем по {creatorId, otherUserId}, оставляем самый старый,
   * остальные удаляем (cascade members + messages). */
  async dedupeDirectRooms() {
    const directs = await this.prisma.chatRoom.findMany({
      where: { type: 'DIRECT' },
      include: { members: { select: { userId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const seen = new Map<string, string>(); // pair-key → kept room id
    let removed = 0;
    for (const r of directs) {
      const ids = r.members.map((m) => m.userId).sort();
      const key = ids.join('|');
      if (seen.has(key)) {
        await this.prisma.chatRoom.delete({ where: { id: r.id } });
        removed++;
      } else {
        seen.set(key, r.id);
      }
    }
    return { removed, kept: seen.size };
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

  // ============ TELEGRAM-STYLE ACTIONS ============

  /** Toggle реакции: если есть — удаляем, иначе создаём. */
  async toggleReaction(messageId: string, userId: string, emoji: string) {
    if (!emoji || emoji.length > 16) throw new BadRequestException('Некорректный эмоджи');
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { roomId: true },
    });
    if (!msg) throw new NotFoundException('Сообщение не найдено');
    // Проверяем что юзер — участник комнаты.
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId: msg.roomId, userId } },
    });
    if (!member) throw new NotFoundException('Чат не найден');

    const existing = await this.prisma.chatReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
    let action: 'added' | 'removed';
    if (existing) {
      await this.prisma.chatReaction.delete({ where: { id: existing.id } });
      action = 'removed';
    } else {
      await this.prisma.chatReaction.create({ data: { messageId, userId, emoji } });
      action = 'added';
    }
    this.realtime.emitStaff('chat:reaction', { roomId: msg.roomId, messageId, userId, emoji, action });
    return { ok: true, action };
  }

  /** Soft-delete: text="", deletedAt=now. Можно автору ИЛИ ADMIN. */
  async deleteMessage(messageId: string, userId: string) {
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { authorId: true, roomId: true, deletedAt: true },
    });
    if (!msg) throw new NotFoundException('Сообщение не найдено');
    if (msg.deletedAt) return { ok: true };
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (msg.authorId !== userId && user?.role !== 'ADMIN') {
      throw new BadRequestException('Можно удалять только свои сообщения');
    }
    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { text: '', attachments: undefined, deletedAt: new Date() },
    });
    this.realtime.emitStaff('chat:message:deleted', { roomId: msg.roomId, messageId });
    return { ok: true };
  }

  /** Pin/unpin сообщение в комнате. ADMIN-only. */
  async togglePin(messageId: string, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user?.role !== 'ADMIN') throw new BadRequestException('Только администратор может закреплять');
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { roomId: true, isPinned: true },
    });
    if (!msg) throw new NotFoundException('Сообщение не найдено');
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { isPinned: !msg.isPinned },
      select: { isPinned: true },
    });
    this.realtime.emitStaff('chat:message:pin', { roomId: msg.roomId, messageId, isPinned: updated.isPinned });
    return { ok: true, isPinned: updated.isPinned };
  }

  /** Forward — копируем текст + attachments в другую комнату с forwardedFromId. */
  async forwardMessage(messageId: string, authorId: string, targetRoomId: string) {
    const orig = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      include: { author: { select: { fullName: true } } },
    });
    if (!orig || orig.deletedAt) throw new NotFoundException('Сообщение не найдено');
    // Security: user must be a member of BOTH rooms (source AND target).
    // Без проверки source комнаты можно было forward'ить сообщение из
    // приватного чата куда у нас нет доступа (если знаем messageId).
    const [sourceMember, targetMember] = await Promise.all([
      this.prisma.chatMember.findUnique({
        where: { roomId_userId: { roomId: orig.roomId, userId: authorId } },
      }),
      this.prisma.chatMember.findUnique({
        where: { roomId_userId: { roomId: targetRoomId, userId: authorId } },
      }),
    ]);
    if (!sourceMember) {
      throw new NotFoundException('Нет доступа к исходному сообщению');
    }
    if (!targetMember) {
      throw new NotFoundException('Целевая комната не найдена');
    }
    const fwd = await this.prisma.chatMessage.create({
      data: {
        roomId: targetRoomId,
        authorId,
        text: orig.text,
        attachments: orig.attachments as any,
        forwardedFromId: orig.id,
      },
      include: {
        author: { select: { id: true, fullName: true, role: true } },
        forwardedFrom: {
          select: {
            id: true, text: true, authorId: true,
            author: { select: { id: true, fullName: true } },
          },
        },
        reactions: { select: { id: true, emoji: true, userId: true } },
      },
    });
    await this.prisma.chatRoom.update({
      where: { id: targetRoomId },
      data: { updatedAt: new Date() },
    });
    this.realtime.emitStaff('chat:message', { roomId: targetRoomId, message: fwd });
    return fwd;
  }

  /** Typing-indicator: эфемерное состояние, не сохраняется в БД.
   *  Просто транслируется в комнату staff. Auto-expire — на стороне клиента. */
  async setTyping(roomId: string, userId: string, typing: boolean) {
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { user: { select: { fullName: true } } },
    });
    if (!member) throw new NotFoundException('Чат не найден');
    this.realtime.emitStaff('chat:typing', {
      roomId,
      userId,
      userName: member.user?.fullName || '',
      typing,
    });
    return { ok: true };
  }

  /** Список закреплённых сообщений в комнате. */
  async listPinned(roomId: string, userId: string) {
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) throw new NotFoundException('Чат не найден');
    return this.prisma.chatMessage.findMany({
      where: { roomId, isPinned: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        author: { select: { id: true, fullName: true, role: true } },
        reactions: { select: { id: true, emoji: true, userId: true } },
      },
    });
  }
}
