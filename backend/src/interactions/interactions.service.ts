import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InteractionType } from '@prisma/client';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class InteractionsService {
  constructor(private prisma: PrismaService, private realtime: RealtimeGateway) {}

  async listForStudent(studentId: string, opts: { visibleToStudentOnly?: boolean } = {}) {
    return this.prisma.interaction.findMany({
      where: {
        studentId,
        ...(opts.visibleToStudentOnly && { visibleToStudent: true }),
      },
      orderBy: { occurredAt: 'desc' },
      include: { author: { select: { id: true, fullName: true, role: true } } },
    });
  }

  /**
   * Полная история взаимодействий по клиенту по ТЗ §8 «Вся связанная
   * информация по клиенту». Объединяет 3 источника:
   *   1. Interaction — ручные записи (звонок/встреча/заметка/...)
   *   2. CallLog — реальные звонки через Dialpad/Twilio
   *   3. ExternalMessage — WhatsApp/Instagram/Telegram/SMS переписка
   *
   * Возвращает плоский массив с дискриминатором `source`, отсортированный
   * по времени убывания. Фронтенд рендерит единой лентой.
   */
  async fullTimeline(studentId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, phones: true },
    });
    if (!student) return [];

    const phoneVariants = student.phones.flatMap((p) => [p, p.replace(/^\+/, '')]);
    const [interactions, callLogs, externalMessages] = await Promise.all([
      this.prisma.interaction.findMany({
        where: { studentId },
        include: { author: { select: { id: true, fullName: true, role: true } } },
      }),
      this.prisma.callLog.findMany({
        where: { studentId },
        include: { user: { select: { id: true, fullName: true, role: true } } },
      }),
      this.prisma.externalMessage.findMany({
        where: {
          OR: [
            { studentId },
            ...phoneVariants.flatMap((p) => [{ fromHandle: p }, { toHandle: p }]),
          ],
        },
      }),
    ]);

    const items: any[] = [
      ...interactions.map((i) => ({
        source: 'interaction',
        id: i.id,
        type: i.type,
        summary: i.summary,
        details: i.details,
        author: i.author,
        occurredAt: i.occurredAt,
      })),
      ...callLogs.map((c) => ({
        source: 'call',
        id: c.id,
        direction: c.direction,
        outcome: c.outcome,
        durationSeconds: c.durationSeconds,
        summary: `${c.direction === 'INCOMING' ? '📞 Входящий' : '📞 Исходящий'} · ${c.clientName}`,
        details: c.notes,
        recordingUrl: c.recordingUrl,
        author: c.user,
        occurredAt: c.occurredAt,
      })),
      ...externalMessages.map((m) => ({
        source: 'message',
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        summary: `${m.channel} · ${m.direction === 'IN' ? 'от клиента' : 'клиенту'}`,
        details: m.content,
        mediaUrl: m.mediaUrl,
        occurredAt: m.createdAt,
      })),
    ];

    items.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    return items;
  }

  async create(authorId: string, dto: {
    studentId: string;
    type: InteractionType;
    summary: string;
    details?: string;
    visibleToStudent?: boolean;
    occurredAt?: string;
  }) {
    if (!dto.studentId) throw new BadRequestException('studentId обязателен');
    if (!dto.summary?.trim()) throw new BadRequestException('Краткое описание обязательно');
    const created = await this.prisma.interaction.create({
      data: {
        studentId: dto.studentId,
        authorId,
        type: dto.type,
        summary: dto.summary.trim(),
        details: dto.details?.trim() || null,
        visibleToStudent: dto.visibleToStudent ?? true,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      },
      include: { author: { select: { id: true, fullName: true, role: true } } },
    });
    // Realtime — студенту в его комнату
    this.realtime.emitStudent(dto.studentId, 'interaction:new', { interaction: created });
    this.realtime.emitStaff('interaction:new', { interaction: created });
    return created;
  }

  async update(id: string, patch: Partial<{
    type: InteractionType;
    summary: string;
    details: string;
    visibleToStudent: boolean;
    occurredAt: string;
  }>) {
    return this.prisma.interaction.update({
      where: { id },
      data: {
        ...(patch.type && { type: patch.type }),
        ...(patch.summary !== undefined && { summary: patch.summary.trim() }),
        ...(patch.details !== undefined && { details: patch.details?.trim() || null }),
        ...(patch.visibleToStudent !== undefined && { visibleToStudent: patch.visibleToStudent }),
        ...(patch.occurredAt && { occurredAt: new Date(patch.occurredAt) }),
      },
    });
  }

  async remove(id: string) {
    return this.prisma.interaction.delete({ where: { id } });
  }
}
