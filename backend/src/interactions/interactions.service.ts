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
    const clean = this.validateInteractionFields({ ...dto, summary: dto.summary }, false);
    const created = await this.prisma.interaction.create({
      data: {
        studentId: dto.studentId,
        authorId,
        type: clean.type as InteractionType,
        summary: clean.summary as string,
        details: clean.details ?? null,
        visibleToStudent: dto.visibleToStudent ?? true,
        occurredAt: clean.occurredAt ?? new Date(),
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
    const clean = this.validateInteractionFields(patch, true);
    return this.prisma.interaction.update({
      where: { id },
      data: {
        ...(clean.type !== undefined && { type: clean.type as InteractionType }),
        ...(clean.summary !== undefined && { summary: clean.summary }),
        ...(clean.details !== undefined && { details: clean.details }),
        ...(patch.visibleToStudent !== undefined && { visibleToStudent: patch.visibleToStudent }),
        ...(clean.occurredAt !== undefined && { occurredAt: clean.occurredAt }),
      },
    });
  }

  /**
   * Валидация полей записи взаимодействия. Раньше service делал только
   * trim+«summary не пуст» — пропускало:
   *   - 10MB summary/details → DB bloat + UI разваливался
   *   - <script> в summary → попадал на студентский portal через
   *     visibleToStudent=true (default!) → stored XSS на клиенте
   *   - type = любая строка → ломал downstream фильтры/иконки
   *   - occurredAt = invalid date → Prisma бросал 500
   */
  private validateInteractionFields(
    data: { type?: any; summary?: string; details?: string; occurredAt?: string },
    partial: boolean,
  ): { type?: any; summary?: string; details?: string | null; occurredAt?: Date } {
    const VALID_TYPES: InteractionType[] = ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'SMS', 'TELEGRAM', 'WHATSAPP'];
    const result: any = {};
    if (data.type !== undefined || !partial) {
      if (!VALID_TYPES.includes(data.type)) {
        throw new BadRequestException(`type должен быть один из: ${VALID_TYPES.join(', ')}`);
      }
      result.type = data.type;
    }
    if (data.summary !== undefined || !partial) {
      const s = (data.summary || '').trim();
      if (!s) throw new BadRequestException('Краткое описание обязательно');
      if (s.length > 500) throw new BadRequestException('Описание слишком длинное (макс. 500)');
      if (/[<>]/.test(s)) throw new BadRequestException('Описание не должно содержать HTML-теги');
      result.summary = s;
    }
    if (data.details !== undefined) {
      const d = (data.details || '').trim();
      if (d.length > 5000) throw new BadRequestException('Детали слишком длинные (макс. 5000)');
      if (/[<>]/.test(d)) throw new BadRequestException('Детали не должны содержать HTML-теги');
      result.details = d || null;
    }
    if (data.occurredAt !== undefined) {
      const dt = new Date(data.occurredAt);
      if (Number.isNaN(dt.getTime())) throw new BadRequestException('occurredAt — некорректная дата');
      result.occurredAt = dt;
    }
    return result;
  }

  async remove(id: string) {
    return this.prisma.interaction.delete({ where: { id } });
  }
}
