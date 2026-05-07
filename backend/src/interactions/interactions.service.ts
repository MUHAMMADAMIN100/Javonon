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
