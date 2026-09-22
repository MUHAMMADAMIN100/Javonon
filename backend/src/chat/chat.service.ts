import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PresenceService } from '../realtime/presence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AiService } from '../ai/ai.service';
import { FinanceService } from '../finance/finance.service';
import { ChatRoomType } from '@prisma/client';

/**
 * Что отдаём о сообщении — везде одинаково: и в переписке, и в событиях
 * сокета. forwardedFrom — автор оригинала для подписи «Переслано от …»
 * (раньше его не было в переписке, и подпись пропадала после перезагрузки).
 */
const MESSAGE_INCLUDE = {
  author: { select: { id: true, fullName: true, role: true } },
  replyTo: {
    select: {
      id: true, text: true, authorId: true, attachments: true, deletedAt: true,
      author: { select: { id: true, fullName: true } },
    },
  },
  forwardedFrom: {
    select: { id: true, authorId: true, author: { select: { id: true, fullName: true } } },
  },
  reactions: { select: { id: true, emoji: true, userId: true } },
} as const;

/** Сколько сообщений в одной порции переписки (остальное — при прокрутке вверх). */
const PAGE_SIZE = 80;
/** Сколько живут кеши участников, комнат и сотрудников. */
const CACHE_MS = 30_000;

type RoomMeta = { id: string; type: ChatRoomType; title: string | null; createdById: string | null; deletedAt: Date | null };
type UserLite = { id: string; fullName: string; email: string; isFounder: boolean };

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  /** Участники комнат — для адресной рассылки событий (кеш на 30 с). */
  private readonly membersCache = new Map<string, { ids: string[]; at: number }>();
  /** Тип, админ и удалена ли комната — проверяется на каждом сообщении. */
  private readonly roomCache = new Map<string, { room: RoomMeta | null; at: number }>();
  /** Сотрудники (имена, упоминания, основатель) — одна выборка на 30 с. */
  private usersCache: { list: UserLite[]; byId: Map<string, UserLite>; at: number } | null = null;
  /**
   * Уже отправленные черновики: clientId → сообщение (2 мин). Если сокет
   * принял сообщение, а подтверждение потерялось, клиент повторит отправку
   * обычным запросом — второй копии не будет.
   */
  private readonly sentByClientId = new Map<string, { msg: any; at: number }>();
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private presence: PresenceService,
    private notifications: NotificationsService,
    private ai: AiService,
    private finance: FinanceService,
  ) {}

  /**
   * Сообщения и «печатает…» — через сокет, с подтверждением: клиент получает
   * готовое сообщение в ответ и сразу заменяет им свой черновик. HTTP-вариант
   * (POST rooms/:id/messages) остаётся для файлов и как запасной путь.
   */
  onModuleInit() {
    this.realtime.onClientEvent('chat:send', async (userId, p: any) => {
      if (!p || typeof p.roomId !== 'string') throw new BadRequestException('Не указан чат');
      const message = await this.sendMessage(p.roomId, userId, String(p.text ?? ''), [], {
        replyToId: typeof p.replyToId === 'string' ? p.replyToId : undefined,
        clientId: typeof p.clientId === 'string' ? p.clientId.slice(0, 64) : undefined,
      });
      return { message };
    });
    // «Прочитал» — тоже через сокет: в живом чате это частое событие, и по
    // HTTP оно съедало лимит запросов (60 в минуту на человека).
    this.realtime.onClientEvent('chat:read', async (userId, p: any) => {
      if (!p || typeof p.roomId !== 'string') return {};
      return this.markRoomRead(p.roomId, userId);
    });
    this.realtime.onClientEvent('chat:typing', async (userId, p: any) => {
      if (!p || typeof p.roomId !== 'string') return {};
      await this.setTyping(p.roomId, userId, !!p.typing);
      return {};
    });
  }

  // ============ КЕШИ И ПРАВА ============

  /** id участников комнаты (кеш 30 с — «печатает…» шлётся часто). */
  private async memberIds(roomId: string): Promise<string[]> {
    const hit = this.membersCache.get(roomId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids;
    const rows = await this.prisma.chatMember.findMany({ where: { roomId }, select: { userId: true } });
    const ids = rows.map((r) => r.userId);
    this.membersCache.set(roomId, { ids, at: Date.now() });
    return ids;
  }

  private async roomMeta(roomId: string): Promise<RoomMeta | null> {
    const hit = this.roomCache.get(roomId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.room;
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      select: { id: true, type: true, title: true, createdById: true, deletedAt: true },
    });
    // Несуществующую комнату не запоминаем: её id мог прийти раньше, чем она создана.
    if (room) this.roomCache.set(roomId, { room, at: Date.now() });
    return room;
  }

  private forgetRoom(roomId: string) {
    this.membersCache.delete(roomId);
    this.roomCache.delete(roomId);
  }

  private async usersIndex() {
    if (this.usersCache && Date.now() - this.usersCache.at < CACHE_MS) return this.usersCache;
    const rows = await this.prisma.user.findMany({ select: { id: true, fullName: true, email: true, role: true, roles: true } });
    const list = rows.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      isFounder: u.role === 'FOUNDER' || (u.roles || []).includes('FOUNDER'),
    }));
    this.usersCache = { list, byId: new Map(list.map((u) => [u.id, u])), at: Date.now() };
    return this.usersCache;
  }

  /**
   * Админ чата: основатель — во всех чатах, в команде — ещё и тот, кто её
   * создал. Админ удаляет чужие сообщения, закрепляет и удаляет команду.
   * В общем чате админ только основатель; в личном — оба собеседника
   * равны (каждый удаляет только своё).
   */
  private async isRoomAdmin(room: RoomMeta, userId: string) {
    const me = (await this.usersIndex()).byId.get(userId);
    if (me?.isFounder) return true;
    return room.type === 'TEAM' && !!room.createdById && room.createdById === userId;
  }

  /** Комната существует, не удалена и человек в ней состоит. */
  private async requireAccess(roomId: string, userId: string): Promise<RoomMeta> {
    const [room, ids] = await Promise.all([this.roomMeta(roomId), this.memberIds(roomId)]);
    if (!room || room.deletedAt || !ids.includes(userId)) {
      throw new NotFoundException('Чат не найден или вы не участник');
    }
    return room;
  }

  /**
   * Событие чата — только участникам комнаты. Раньше всё шло в общую
   * комнату staff: личная переписка доходила до браузера каждого сотрудника.
   */
  private async emitRoom(roomId: string, event: string, payload: any) {
    this.realtime.emitUsers(await this.memberIds(roomId), event, payload);
  }

  /** Удалённое сообщение без вложений — их не видно никому. */
  private shape<T extends { deletedAt: Date | null; attachments?: any }>(m: T): T {
    return m.deletedAt ? { ...m, text: '', attachments: null } : m;
  }

  // ============ КОМНАТЫ ============

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
      // Новому участнику старая переписка не «непрочитанная» — отсчёт с момента входа.
      await this.prisma.chatMember.createMany({
        data: toAdd.map((u) => ({ roomId: room!.id, userId: u.id, lastReadAt: new Date() })),
      });
      this.membersCache.delete(room.id);
    }
    return room;
  }

  async listRooms(userId: string) {
    await this.ensureGeneralRoom();
    const rooms = await this.prisma.chatRoom.findMany({
      where: { deletedAt: null, members: { some: { userId } } },
      orderBy: { updatedAt: 'desc' },
      include: {
        members: {
          include: { user: { select: { id: true, fullName: true, role: true } } },
        },
        // Последнее живое сообщение: удалённые исчезают совсем (как в Telegram).
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { author: { select: { id: true, fullName: true } } },
        },
      },
    });
    // «Удалил чат у себя» — чат скрыт, пока в нём не появится что-то новое;
    // старая переписка (и её последнее сообщение в списке) остаётся скрытой.
    const out: typeof rooms = [];
    for (const r of rooms) {
      const cleared = r.members.find((m) => m.userId === userId)?.clearedAt;
      if (!cleared) { out.push(r); continue; }
      if (r.updatedAt <= cleared) continue;
      out.push({ ...r, messages: r.messages.filter((m) => m.createdAt > cleared) });
    }
    return out.map((r) => ({ ...r, messages: r.messages.map((m) => this.shape(m)) }));
  }

  /**
   * Переписка порциями: без before — последние сообщения (и чат отмечается
   * прочитанным), с before — более старые, для прокрутки вверх и поиска.
   */
  async getRoom(roomId: string, userId: string, before?: string) {
    await this.requireAccess(roomId, userId);
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { clearedAt: true },
    });
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && Number.isNaN(beforeDate.getTime())) throw new BadRequestException('Некорректная дата');
    const createdAt: { gt?: Date; lt?: Date } = {};
    if (member?.clearedAt) createdAt.gt = member.clearedAt;
    if (beforeDate) createdAt.lt = beforeDate;

    // Удалённые не отдаём вовсе — у всех они просто исчезают.
    const recent = await this.prisma.chatMessage.findMany({
      where: { roomId, deletedAt: null, ...(createdAt.gt || createdAt.lt ? { createdAt } : {}) },
      orderBy: { createdAt: 'desc' },
      include: MESSAGE_INCLUDE,
      take: PAGE_SIZE + 1,
    });
    const hasMore = recent.length > PAGE_SIZE;
    const messages = recent.slice(0, PAGE_SIZE).reverse().map((m) => this.shape(m));
    if (!beforeDate) await this.recordRead(roomId, userId);
    return { messages, hasMore };
  }

  /** Поиск по переписке комнаты (без удалённых и скрытых «удалить у себя»). */
  async searchMessages(roomId: string, userId: string, q: string) {
    await this.requireAccess(roomId, userId);
    const query = (q || '').trim();
    if (query.length < 2) return [];
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { clearedAt: true },
    });
    return this.prisma.chatMessage.findMany({
      where: {
        roomId,
        deletedAt: null,
        text: { contains: query.slice(0, 100), mode: 'insensitive' },
        ...(member?.clearedAt ? { createdAt: { gt: member.clearedAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, text: true, createdAt: true, authorId: true, author: { select: { id: true, fullName: true } } },
    });
  }

  /**
   * Участники чата и кто из них в сети — видят все участники (решение
   * заказчика). Подробная история входов остаётся только у основателя.
   */
  async roomMembers(roomId: string, userId: string) {
    const room = await this.requireAccess(roomId, userId);
    const rows = await this.prisma.chatMember.findMany({
      where: { roomId },
      select: { user: { select: { id: true, fullName: true, role: true, roles: true, isActive: true, lastSeenAt: true } } },
    });
    const live = this.presence.snapshot();
    const idx = await this.usersIndex();
    return rows
      .map(({ user: u }) => {
        const now = u.isActive !== false ? live.get(u.id) : undefined;
        return {
          id: u.id,
          fullName: u.fullName,
          role: u.role,
          roles: u.roles,
          online: now?.state === 'ONLINE',
          lastSeenAt: now ? now.lastActivityAt : u.lastSeenAt,
          isAdmin: !!idx.byId.get(u.id)?.isFounder || (room.type === 'TEAM' && room.createdById === u.id),
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.isAdmin) - Number(a.isAdmin) || a.fullName.localeCompare(b.fullName, 'ru'));
  }

  /** Telegram-style: пометить как прочитано (повторно, при scroll/focus). */
  async markRoomRead(roomId: string, userId: string) {
    await this.requireAccess(roomId, userId);
    const lastReadAt = await this.recordRead(roomId, userId);
    return { ok: true, lastReadAt: lastReadAt.toISOString() };
  }

  /**
   * Прочитал: для каждого нового (с прошлого раза) чужого сообщения
   * запоминаем время — из этого меню «Прочитали» у автора. Затем двигаем
   * lastReadAt, и собеседники сразу видят ✓✓.
   */
  private async recordRead(roomId: string, userId: string) {
    const now = new Date();
    const member = await this.prisma.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { lastReadAt: true },
    });
    const fresh = await this.prisma.chatMessage.findMany({
      where: {
        roomId,
        authorId: { not: userId },
        deletedAt: null,
        createdAt: { lte: now, ...(member?.lastReadAt ? { gt: member.lastReadAt } : {}) },
      },
      select: { id: true },
    });
    if (fresh.length) {
      await this.prisma.chatMessageRead.createMany({
        data: fresh.map((m) => ({ messageId: m.id, userId, readAt: now })),
        skipDuplicates: true,
      });
    }
    await this.prisma.chatMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { lastReadAt: now },
    });
    await this.emitRoom(roomId, 'chat:read', { roomId, userId, lastReadAt: now.toISOString() });
    return now;
  }

  /**
   * Кто прочитал моё сообщение и когда — только автору. Для сообщений до
   * появления таблицы прочтений время неизвестно: «прочитал» без времени,
   * если человек заходил в чат после сообщения.
   */
  async messageReads(messageId: string, userId: string) {
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { roomId: true, authorId: true, createdAt: true, deletedAt: true },
    });
    if (!msg || msg.deletedAt) throw new NotFoundException('Сообщение не найдено');
    await this.requireAccess(msg.roomId, userId);
    if (msg.authorId !== userId) throw new ForbiddenException('Кто прочитал — видно только автору сообщения');
    const [members, reads] = await Promise.all([
      this.prisma.chatMember.findMany({
        where: { roomId: msg.roomId, userId: { not: userId } },
        select: { userId: true, lastReadAt: true, user: { select: { fullName: true } } },
      }),
      this.prisma.chatMessageRead.findMany({ where: { messageId }, select: { userId: true, readAt: true } }),
    ]);
    const at = new Map(reads.map((r) => [r.userId, r.readAt]));
    return members
      .map((m) => ({
        userId: m.userId,
        fullName: m.user.fullName,
        readAt: at.get(m.userId) ?? null,
        read: at.has(m.userId) || (!!m.lastReadAt && m.lastReadAt >= msg.createdAt),
      }))
      .filter((r) => r.read)
      // Свежие прочтения сверху, «без времени» — в конце.
      .sort((a, b) => (b.readAt?.getTime() ?? 0) - (a.readAt?.getTime() ?? 0) || a.fullName.localeCompare(b.fullName, 'ru'))
      .map(({ userId: id, fullName, readAt }) => ({ userId: id, fullName, readAt }));
  }

  // ============ СООБЩЕНИЯ ============

  /**
   * Отправка. Скорость — главное: до рассылки собеседникам остаётся одна
   * запись в базу (само сообщение). Участники, комната и сотрудники берутся
   * из кеша, проверка ответа и упоминаний идут параллельно, а обновление
   * списка чатов, уведомления и AI — уже после рассылки.
   */
  async sendMessage(
    roomId: string,
    authorId: string,
    text: string,
    mentionsIds: string[] = [],
    options: { replyToId?: string; attachments?: any[]; clientId?: string } = {},
  ) {
    if (options.clientId) {
      const key = `${authorId}:${options.clientId}`;
      const seen = this.sentByClientId.get(key);
      if (seen && Date.now() - seen.at < 120_000) return seen.msg;
    }
    const trimmed = (text || '').trim();
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    // Сообщение может быть только из вложений (без текста) или только текст.
    if (!trimmed && !hasAttachments) throw new BadRequestException('Пустое сообщение');
    if (trimmed.length > 4000) throw new BadRequestException('Слишком длинное сообщение');

    const [room, , resolved] = await Promise.all([
      this.requireAccess(roomId, authorId),
      // Ответ — только на сообщение из этой же комнаты.
      options.replyToId
        ? this.prisma.chatMessage
            .findUnique({ where: { id: options.replyToId }, select: { roomId: true } })
            .then((orig) => {
              if (!orig || orig.roomId !== roomId) {
                throw new BadRequestException('Невозможно ответить: исходное сообщение не найдено');
              }
            })
        : Promise.resolve(),
      this.resolveMentions(trimmed, mentionsIds, authorId),
    ]);

    const msg = await this.prisma.chatMessage.create({
      data: {
        roomId,
        authorId,
        text: trimmed,
        mentionsIds: resolved,
        replyToId: options.replyToId || null,
        attachments: hasAttachments ? (options.attachments as any) : undefined,
      },
      include: MESSAGE_INCLUDE,
    });

    if (options.clientId) {
      const now = Date.now();
      for (const [k, v] of this.sentByClientId) if (now - v.at > 120_000) this.sentByClientId.delete(k);
      this.sentByClientId.set(`${authorId}:${options.clientId}`, { msg, at: now });
    }
    // clientId — метка черновика у автора: по ней он заменяет свой черновик
    // на это сообщение, даже если сокет-событие пришло раньше ответа.
    await this.emitRoom(roomId, 'chat:message', { roomId, message: msg, clientId: options.clientId });

    // Всё остальное — в фоне, без await: не задерживает ни автора, ни рассылку.
    this.afterSendBackground(msg, room, authorId, trimmed, resolved, msg.author?.fullName).catch(
      (err) => this.logger.error(`afterSendBackground failed: ${err?.message}`),
    );

    return msg;
  }

  /**
   * Упомянутые сотрудники: из списка клиента или из текста (@имя-фамилия,
   * @id, @почта). Только реально существующие и не сам автор — выдуманный
   * id раньше давал FK-500 при уведомлении.
   */
  private async resolveMentions(text: string, fromClient: string[], authorId: string): Promise<string[]> {
    if (!fromClient.length && !text.includes('@')) return [];
    const idx = await this.usersIndex();
    let ids = fromClient.length ? fromClient : this.mentionsFromText(text, idx.list);
    ids = Array.from(new Set(ids)).filter((id) => id !== authorId && idx.byId.has(id));
    return ids;
  }

  /** Парсим из текста все @<word> и ищем соответствующего сотрудника. */
  private mentionsFromText(text: string, users: UserLite[]): string[] {
    const matches = text.match(/@([\wа-яА-ЯёЁ.\-]+)/g);
    if (!matches?.length) return [];
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

  /** Фоновая работа после рассылки: порядок в списке чатов, уведомления, AI. */
  private async afterSendBackground(
    msg: { id: string },
    room: RoomMeta,
    authorId: string,
    trimmed: string,
    resolvedMentions: string[],
    authorName?: string,
  ) {
    const roomId = room.id;
    await this.prisma.chatRoom.update({
      where: { id: roomId },
      data: { updatedAt: new Date() },
    });

    const mentionedSet = new Set(resolvedMentions);
    const allMembers = await this.memberIds(roomId);
    const roomLabel = room.type === 'GENERAL'
      ? 'Команда Javonon'
      : room.type === 'TEAM'
        ? room.title || 'Команда'
        : authorName || 'Чат';

    const tasks: Promise<unknown>[] = [];
    for (const mid of resolvedMentions) {
      tasks.push(this.notifications.notifyUser(mid, {
        type: 'CHAT_MENTION',
        title: `💬 Вас упомянул ${authorName || 'кто-то'}`,
        message: trimmed.slice(0, 140),
        payload: { roomId, messageId: msg.id, authorId },
      }));
    }
    for (const uid of allMembers) {
      if (uid === authorId) continue;
      if (mentionedSet.has(uid)) continue;
      tasks.push(this.notifications.notifyUser(uid, {
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
      select: { role: true, roles: true, fullName: true },
    });
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT) могут вызвать AI-парсинг
    // финансов чат-ботом. Multi-role: проверяем primary И roles[]
    // (раньше primary-only пропускало secondary-ADMIN/ACCOUNTANT).
    const isElevatedAuthor = author && (
      author.role === 'FOUNDER' || author.role === 'ADMIN' || author.role === 'ACCOUNTANT' ||
      (author.roles || []).some((r) => r === 'FOUNDER' || r === 'ADMIN' || r === 'ACCOUNTANT')
    );
    if (!isElevatedAuthor) {
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
    // Bot-сообщения пишутся от первого elevated-юзера (FOUNDER/ADMIN/
    // ACCOUNTANT), чтобы Foreign Key не падал. Учитываем мульти-роли —
    // юзер с ADMIN в roles[] тоже подходит. Раньше требовался строго
    // primary=ADMIN, и в компании где только FOUNDER + accountants
    // системный бот не мог писать.
    const admin = await this.prisma.user.findFirst({
      where: {
        OR: [
          { role: { in: ['FOUNDER', 'ADMIN', 'ACCOUNTANT'] } },
          { roles: { hasSome: ['FOUNDER', 'ADMIN', 'ACCOUNTANT'] } },
        ],
      },
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
      include: MESSAGE_INCLUDE,
    });
    await this.emitRoom(roomId, 'chat:message', { roomId, message: msg });
  }

  async createTeamRoom(creatorId: string, title: string, memberIds: string[]) {
    // Минимальная валидация title — раньше @Body() body: { title } без DTO
    // пропускал что угодно, включая `<script>`. React автоэкранирует, но
    // имена rooms светятся в Telegram-уведомлениях (html-mode) и в
    // activity-логах — нужна общая защита.
    const trimmed = (title || '').trim();
    if (!trimmed || trimmed.length < 2) {
      throw new BadRequestException('Название комнаты обязательно (мин. 2 символа)');
    }
    if (trimmed.length > 120) {
      throw new BadRequestException('Название комнаты слишком длинное (макс. 120 символов)');
    }
    if (/[<>]/.test(trimmed)) {
      throw new BadRequestException('Название комнаты не должно содержать HTML-теги');
    }
    title = trimmed;
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
        createdById: creatorId,
        members: { create: ids.map((id) => ({ userId: id })) },
      },
      include: {
        members: { include: { user: { select: { id: true, fullName: true, role: true } } } },
      },
    });
    this.forgetRoom(room.id);
    this.realtime.emitUsers(ids, 'chat:room', { room });
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
      if (existing) {
        // Чат был «удалён у себя» — снова открываем его (старая переписка
        // остаётся скрытой): поднимаем, чтобы он вернулся в список.
        if (existing.members.some((m) => m.userId === creatorId && m.clearedAt)) {
          return tx.chatRoom.update({ where: { id: existing.id }, data: { updatedAt: new Date() }, include: includeAll });
        }
        return existing;
      }
      const room = await tx.chatRoom.create({
        data: {
          type: 'DIRECT',
          title: otherUser.fullName || 'Прямой чат',
          members: { create: [{ userId: creatorId }, { userId: otherUserId }] },
        },
        include: includeAll,
      });
      // Собеседник видит новый чат в списке сразу, без перезагрузки.
      this.realtime.emitUsers([creatorId, otherUserId], 'chat:room', { room });
      return room;
    });
  }

  /**
   * «Удалить чат».
   *  - Общий чат удалить нельзя.
   *  - Личный: «только у меня» — переписка скрывается у меня; «у обоих» —
   *    у обоих. Чат вернётся в список с новым сообщением. В базе всё остаётся.
   *  - Команда: удаляет только админ (у всех); остальные могут только выйти.
   */
  async deleteRoom(roomId: string, userId: string, forAll: boolean) {
    const room = await this.requireAccess(roomId, userId);
    if (room.type === 'GENERAL') throw new BadRequestException('Общий чат удалить нельзя');
    const now = new Date();
    if (room.type === 'DIRECT') {
      const ids = forAll ? await this.memberIds(roomId) : [userId];
      await this.prisma.chatMember.updateMany({
        where: { roomId, userId: { in: ids } },
        data: { clearedAt: now, lastReadAt: now },
      });
      this.realtime.emitUsers(ids, 'chat:room:removed', { roomId });
      return { ok: true };
    }
    if (!(await this.isRoomAdmin(room, userId))) {
      throw new ForbiddenException('Удалить команду может только её админ. Вы можете выйти из команды.');
    }
    const ids = await this.memberIds(roomId);
    await this.prisma.chatRoom.update({ where: { id: roomId }, data: { deletedAt: now } });
    this.forgetRoom(roomId);
    this.realtime.emitUsers(ids, 'chat:room:removed', { roomId });
    return { ok: true };
  }

  /** Выйти из команды (в общем и личном чате — нельзя). */
  async leaveRoom(roomId: string, userId: string) {
    const room = await this.requireAccess(roomId, userId);
    if (room.type !== 'TEAM') throw new BadRequestException('Выйти можно только из команды');
    await this.prisma.chatMember.delete({ where: { roomId_userId: { roomId, userId } } });
    this.forgetRoom(roomId);
    this.realtime.emitUser(userId, 'chat:room:removed', { roomId });
    // Остальным — обновить список участников.
    this.realtime.emitUsers(await this.memberIds(roomId), 'chat:room', { roomId });
    return { ok: true };
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

  /**
   * Непрочитанные по каждой комнате — настоящее число сообщений после
   * lastReadAt (не свои, не удалённые). Раньше отдавалось 0/1 по последнему
   * сообщению, и счётчик «5 новых» показать было не из чего.
   */
  async unreadCounts(userId: string) {
    // mentions — сколько из них упоминают этого человека (значок «@»).
    const rows = await this.prisma.$queryRaw<{ roomId: string; unread: bigint; mentions: bigint }[]>`
      SELECT m."roomId", COUNT(msg.id) AS unread,
             COUNT(msg.id) FILTER (WHERE ${userId} = ANY(msg."mentionsIds")) AS mentions
      FROM "ChatMember" m
      JOIN "ChatRoom" r ON r.id = m."roomId" AND r."deletedAt" IS NULL
      LEFT JOIN "ChatMessage" msg
        ON msg."roomId" = m."roomId"
       AND msg."authorId" <> m."userId"
       AND msg."deletedAt" IS NULL
       AND (m."lastReadAt" IS NULL OR msg."createdAt" > m."lastReadAt")
       AND (m."clearedAt" IS NULL OR msg."createdAt" > m."clearedAt")
      WHERE m."userId" = ${userId}
      GROUP BY m."roomId"`;
    return rows.map((r) => ({ roomId: r.roomId, unread: Number(r.unread), mentions: Number(r.mentions) }));
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
    await this.requireAccess(msg.roomId, userId);

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
    await this.emitRoom(msg.roomId, 'chat:reaction', { roomId: msg.roomId, messageId, userId, emoji, action });
    return { ok: true, action };
  }

  /**
   * Удалить сообщения (одно или несколько выбранных). Soft-delete: текст
   * стирается, deletedAt ставится, у всех видно «Сообщение удалено».
   * Свои — может каждый; чужие — только админ чата (создатель команды,
   * основатель). Раньше чужие мог удалить любой администратор CRM.
   */
  async deleteMessages(messageIds: string[], userId: string) {
    const ids = Array.from(new Set((messageIds || []).filter((x) => typeof x === 'string'))).slice(0, 200);
    if (!ids.length) throw new BadRequestException('Не выбраны сообщения');
    const msgs = await this.prisma.chatMessage.findMany({
      where: { id: { in: ids } },
      select: { id: true, authorId: true, roomId: true, deletedAt: true },
    });
    if (msgs.length !== ids.length) throw new NotFoundException('Сообщение не найдено');
    const roomId = msgs[0].roomId;
    if (msgs.some((m) => m.roomId !== roomId)) throw new BadRequestException('Сообщения из разных чатов');
    const room = await this.requireAccess(roomId, userId);
    const foreign = msgs.some((m) => m.authorId !== userId);
    if (foreign && !(await this.isRoomAdmin(room, userId))) {
      throw new ForbiddenException('Чужие сообщения может удалить только админ группы');
    }
    const toDelete = msgs.filter((m) => !m.deletedAt).map((m) => m.id);
    if (toDelete.length) {
      await this.prisma.chatMessage.updateMany({
        where: { id: { in: toDelete } },
        data: { text: '', deletedAt: new Date() },
      });
      await this.emitRoom(roomId, 'chat:message:deleted', { roomId, messageIds: toDelete, messageId: toDelete[0] });
    }
    return { ok: true, deleted: toDelete.length };
  }

  deleteMessage(messageId: string, userId: string) {
    return this.deleteMessages([messageId], userId);
  }

  /** Изменить своё сообщение — у всех обновляется сразу, с пометкой «изменено». */
  async editMessage(messageId: string, userId: string, text: string) {
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { authorId: true, roomId: true, deletedAt: true, attachments: true, mentionsIds: true, text: true },
    });
    if (!msg || msg.deletedAt) throw new NotFoundException('Сообщение не найдено');
    await this.requireAccess(msg.roomId, userId);
    if (msg.authorId !== userId || msg.mentionsIds.includes('__BOT__')) {
      throw new ForbiddenException('Изменять можно только свои сообщения');
    }
    const trimmed = (text || '').trim();
    const hasAttachments = Array.isArray(msg.attachments) && (msg.attachments as any[]).length > 0;
    if (!trimmed && !hasAttachments) throw new BadRequestException('Пустое сообщение');
    if (trimmed.length > 4000) throw new BadRequestException('Слишком длинное сообщение');
    if (trimmed === msg.text) return { ok: true, id: messageId, text: msg.text };
    const mentionsIds = await this.resolveMentions(trimmed, [], userId);
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { text: trimmed, mentionsIds, editedAt: new Date() },
      select: { id: true, text: true, editedAt: true, mentionsIds: true },
    });
    await this.emitRoom(msg.roomId, 'chat:message:edited', {
      roomId: msg.roomId,
      messageId,
      text: updated.text,
      editedAt: updated.editedAt,
      mentionsIds: updated.mentionsIds,
    });
    return { ok: true, ...updated };
  }

  /** Закрепить/открепить: в группе — админ чата, в личном — любой из двоих. */
  async togglePin(messageId: string, userId: string) {
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { roomId: true, isPinned: true },
    });
    if (!msg) throw new NotFoundException('Сообщение не найдено');
    const room = await this.requireAccess(msg.roomId, userId);
    if (room.type !== 'DIRECT' && !(await this.isRoomAdmin(room, userId))) {
      throw new ForbiddenException('Закреплять может только админ группы');
    }
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { isPinned: !msg.isPinned },
      select: { isPinned: true },
    });
    await this.emitRoom(msg.roomId, 'chat:message:pin', { roomId: msg.roomId, messageId, isPinned: updated.isPinned });
    return { ok: true, isPinned: updated.isPinned };
  }

  /**
   * Переслать — копия текста и вложений с forwardedFromId. Пересылка
   * пересланного указывает на оригинал: «Переслано от» — настоящий автор.
   */
  async forwardMessage(messageId: string, authorId: string, targetRoomId: string) {
    const orig = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, roomId: true, text: true, attachments: true, deletedAt: true, forwardedFromId: true },
    });
    if (!orig || orig.deletedAt) throw new NotFoundException('Сообщение не найдено');
    // Нужен доступ к обоим чатам: иначе, зная id, можно было бы вытащить
    // сообщение из чужого личного чата.
    try {
      await this.requireAccess(orig.roomId, authorId);
    } catch {
      throw new NotFoundException('Нет доступа к исходному сообщению');
    }
    try {
      await this.requireAccess(targetRoomId, authorId);
    } catch {
      throw new NotFoundException('Целевая комната не найдена');
    }
    const fwd = await this.prisma.chatMessage.create({
      data: {
        roomId: targetRoomId,
        authorId,
        text: orig.text,
        attachments: orig.attachments as any,
        forwardedFromId: orig.forwardedFromId || orig.id,
      },
      include: MESSAGE_INCLUDE,
    });
    await this.emitRoom(targetRoomId, 'chat:message', { roomId: targetRoomId, message: fwd });
    await this.prisma.chatRoom.update({
      where: { id: targetRoomId },
      data: { updatedAt: new Date() },
    });
    return fwd;
  }

  /** Typing-indicator: эфемерное состояние, не сохраняется в БД.
   *  Только участникам комнаты. Auto-expire — на стороне клиента. */
  async setTyping(roomId: string, userId: string, typing: boolean) {
    await this.requireAccess(roomId, userId);
    const name = (await this.usersIndex()).byId.get(userId)?.fullName || '';
    await this.emitRoom(roomId, 'chat:typing', { roomId, userId, userName: name, typing });
    return { ok: true };
  }

  /** Список закреплённых сообщений в комнате. */
  async listPinned(roomId: string, userId: string) {
    await this.requireAccess(roomId, userId);
    return this.prisma.chatMessage.findMany({
      where: { roomId, isPinned: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: MESSAGE_INCLUDE,
    });
  }
}
