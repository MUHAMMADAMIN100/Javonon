import { Injectable } from '@nestjs/common';
import { ExternalMessageChannel, ExternalMessageDirection } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Просмотр сообщений из внешних каналов (WhatsApp/Instagram/Telegram/SMS).
 * Используется для отображения единой ленты входящих в CRM (по ТЗ §10c —
 * Instagram-чат в CRM).
 */
@Injectable()
export class InboxService {
  constructor(private prisma: PrismaService) {}

  async list(opts: {
    channel?: ExternalMessageChannel;
    direction?: ExternalMessageDirection;
    applicationId?: string;
    studentId?: string;
    take?: number;
  }) {
    return this.prisma.externalMessage.findMany({
      where: {
        ...(opts.channel && { channel: opts.channel }),
        ...(opts.direction && { direction: opts.direction }),
        ...(opts.applicationId && { applicationId: opts.applicationId }),
        ...(opts.studentId && { studentId: opts.studentId }),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take || 200, 500),
    });
  }

  /** Свести список «диалогов» — последнее сообщение по каждому собеседнику. */
  async threads(opts: { channel?: ExternalMessageChannel; take?: number }) {
    // Простой подход: берём последние 500 сообщений, группируем по handle.
    // Для production-сервиса с большим объёмом нужно $queryRaw с window
    // функциями, но для текущего масштаба этого достаточно.
    const messages = await this.prisma.externalMessage.findMany({
      where: opts.channel ? { channel: opts.channel } : {},
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const seen = new Set<string>();
    const threads: typeof messages = [];
    for (const m of messages) {
      const handle = m.direction === 'IN' ? m.fromHandle : m.toHandle;
      const key = `${m.channel}:${handle}`;
      if (handle && !seen.has(key)) {
        seen.add(key);
        threads.push(m);
      }
    }
    return threads.slice(0, Math.min(opts.take || 100, 200));
  }

  /** История переписки с одним собеседником в рамках одного канала. */
  async thread(channel: ExternalMessageChannel, handle: string) {
    return this.prisma.externalMessage.findMany({
      where: {
        channel,
        OR: [{ fromHandle: handle }, { toHandle: handle }],
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }
}
