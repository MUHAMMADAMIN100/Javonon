import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * «Кто в сети» — для основателя (экран «Сотрудники» и профиль).
 *
 * Источник правды — открытые сокеты: пока у сотрудника открыта хотя бы одна
 * вкладка CRM, он «здесь». Внутри этого — два состояния:
 *   ONLINE — было действие (клик, ввод, прокрутка) за последние AWAY_AFTER;
 *   AWAY   — вкладка открыта, но действий дольше (человек отошёл).
 * Нет вкладок — OFFLINE, и тогда показываем lastSeenAt из базы.
 *
 * Состояние живёт в памяти процесса: backend на Railway — один инстанс.
 * При рестарте сокеты переподключаются сами (reconnection на клиенте), и
 * карта восстанавливается за секунды. lastSeenAt пишем в базу — чтобы
 * «был(а) в сети …» переживал и рестарт, и уход человека.
 */
export type PresenceState = 'ONLINE' | 'AWAY' | 'OFFLINE';

/** Сколько без действий, прежде чем «в сети» станет «отошёл». */
export const AWAY_AFTER_MS = 5 * 60_000;
/** Как часто пересчитываем ONLINE→AWAY и пишем lastSeenAt в базу. */
const TICK_MS = 30_000;

type Entry = { sockets: Set<string>; lastActivityAt: number; state: PresenceState };

@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly users = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  /** Кому сообщать о смене состояния (ставит RealtimeGateway). */
  private notify: (userId: string, state: PresenceState, lastSeenAt: Date) => void = () => {};

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  setNotifier(fn: (userId: string, state: PresenceState, lastSeenAt: Date) => void) {
    this.notify = fn;
  }

  /** Открылась вкладка CRM сотрудника. */
  connected(userId: string, socketId: string) {
    const now = Date.now();
    const e = this.users.get(userId) ?? { sockets: new Set<string>(), lastActivityAt: now, state: 'OFFLINE' as PresenceState };
    e.sockets.add(socketId);
    e.lastActivityAt = now;
    this.users.set(userId, e);
    this.setState(userId, e, 'ONLINE');
    void this.saveLastSeen(userId, new Date(now));
  }

  /** Закрылась вкладка. Последняя — человек ушёл: фиксируем момент. */
  disconnected(userId: string, socketId: string) {
    const e = this.users.get(userId);
    if (!e) return;
    e.sockets.delete(socketId);
    if (e.sockets.size > 0) return;
    this.users.delete(userId);
    const now = new Date();
    e.state = 'OFFLINE';
    void this.saveLastSeen(userId, now);
    this.notify(userId, 'OFFLINE', now);
  }

  /** Клиент сообщил о действии человека (не чаще раза в 30 с). */
  activity(userId: string) {
    const e = this.users.get(userId);
    if (!e) return;
    e.lastActivityAt = Date.now();
    this.setState(userId, e, 'ONLINE');
  }

  /** Состояние всех, у кого сейчас открыта CRM (остальные — OFFLINE). */
  snapshot(): Map<string, { state: PresenceState; lastActivityAt: Date }> {
    const out = new Map<string, { state: PresenceState; lastActivityAt: Date }>();
    for (const [id, e] of this.users) out.set(id, { state: e.state, lastActivityAt: new Date(e.lastActivityAt) });
    return out;
  }

  private setState(userId: string, e: Entry, next: PresenceState) {
    if (e.state === next) return;
    e.state = next;
    this.notify(userId, next, new Date(e.lastActivityAt));
  }

  private async tick() {
    const now = Date.now();
    for (const [id, e] of this.users) {
      if (e.state === 'ONLINE' && now - e.lastActivityAt >= AWAY_AFTER_MS) this.setState(id, e, 'AWAY');
    }
    // «Последняя активность» в базе — пока человек что-то делает. У
    // отошедшего она остаётся моментом последнего действия.
    const active = [...this.users.entries()].filter(([, e]) => e.state === 'ONLINE');
    for (const [id, e] of active) await this.saveLastSeen(id, new Date(e.lastActivityAt));
  }

  private async saveLastSeen(userId: string, at: Date) {
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: at } });
    } catch (err) {
      // Пользователя удалили, пока вкладка была открыта, — не повод падать.
      this.logger.warn(`lastSeenAt не сохранён для ${userId}: ${(err as Error).message}`);
    }
  }
}
