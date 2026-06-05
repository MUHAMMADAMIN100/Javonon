import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isElevated } from '../auth/role-utils';

/**
 * SalesService — авто-распределение лидов и управление воронками.
 *
 * Авто-распределение: round-robin среди SALES_MANAGER. Метрика «наименее
 * загружен» — текущее число активных заявок (не ENROLLED/COMPLETED).
 * Это можно потом усложнить (учитывать выходные, отпуска), сейчас
 * простой и предсказуемый алгоритм.
 */
@Injectable()
export class SalesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Найти default-воронку и её первый этап. Используется при создании
   * Application для авто-проставления pipelineId/pipelineStageId.
   * Если default-воронка не настроена — возвращает null'ы (заявка
   * создаётся без воронки, можно проставить позже вручную).
   */
  async pickDefaultPipelineStage(): Promise<{ pipelineId: string | null; pipelineStageId: string | null }> {
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { isDefault: true, isActive: true },
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    });
    if (!pipeline) return { pipelineId: null, pipelineStageId: null };
    return {
      pipelineId: pipeline.id,
      pipelineStageId: pipeline.stages[0]?.id ?? null,
    };
  }

  /**
   * Передвинуть Application на новый этап воронки.
   * - Если новый этап принадлежит другой воронке — переносим заявку
   *   в эту воронку (обновляем оба поля).
   * - Доступ — те же роли что и reassign: elevated всем, manager — своим.
   */
  async moveStage(
    applicationId: string,
    pipelineStageId: string | null,
    requester: { id: string; role?: string; roles?: string[] },
  ) {
    const app = await this.prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) throw new NotFoundException('Заявка не найдена');
    if (!isElevated(requester) && app.managerId !== requester.id) {
      throw new ForbiddenException('Можно двигать только свои заявки');
    }
    if (!pipelineStageId) {
      return this.prisma.application.update({
        where: { id: applicationId },
        data: { pipelineStageId: null },
      });
    }
    const stage = await this.prisma.pipelineStage.findUnique({
      where: { id: pipelineStageId },
      include: { pipeline: true },
    });
    if (!stage) throw new BadRequestException('Этап не найден');
    return this.prisma.application.update({
      where: { id: applicationId },
      data: {
        pipelineStageId: stage.id,
        pipelineId: stage.pipelineId,
      },
      include: {
        pipeline: true,
        pipelineStage: true,
      },
    });
  }

  /**
   * Подобрать менеджера для нового лида. Возвращает userId или null
   * если нет SALES_MANAGER в системе. Логика:
   *   1. Берём всех SALES_MANAGER.
   *   2. Считаем у каждого число активных (не закрытых) Application.
   *   3. Берём с минимальным числом. Если несколько — берём с самым
   *      ранним createdAt (равномерно распределяет в пустой системе).
   */
  async pickManagerForLead(): Promise<string | null> {
    // Мульти-роли (ТЗ §2): юзер с SALES_MANAGER в roles[] тоже считается
    // менеджером — раньше auto-distribute их пропускал.
    const managers = await this.prisma.user.findMany({
      where: {
        OR: [
          { role: 'SALES_MANAGER' },
          { roles: { has: 'SALES_MANAGER' } },
        ],
      },
      select: { id: true, createdAt: true },
    });
    if (managers.length === 0) return null;
    const counts = await Promise.all(
      managers.map(async (m) => ({
        userId: m.id,
        createdAt: m.createdAt,
        load: await this.prisma.application.count({
          where: {
            managerId: m.id,
            status: { notIn: ['ENROLLED', 'COMPLETED'] },
          },
        }),
      })),
    );
    counts.sort((a, b) => {
      if (a.load !== b.load) return a.load - b.load;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    return counts[0].userId;
  }

  /**
   * Ручное переназначение лида менеджеру.
   * - Elevated (FOUNDER/ADMIN/ACCOUNTANT) — может переназначить любую заявку.
   * - SALES_MANAGER — только если он сам сейчас является managerId этой
   *   заявки (передаёт свою на другого).
   * - Все остальные — 403.
   */
  async reassign(
    applicationId: string,
    newManagerId: string | null,
    requester: { id: string; role?: string; roles?: string[] },
  ) {
    const app = await this.prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) throw new NotFoundException('Заявка не найдена');

    // Без elevated можно переназначать ТОЛЬКО заявки, где ты сейчас менеджер.
    // Это закрывает дыру: до этого SALES_MANAGER мог через /sales endpoint
    // забрать себе любую чужую заявку.
    if (!isElevated(requester) && app.managerId !== requester.id) {
      throw new ForbiddenException('Переназначать можно только свои заявки');
    }

    if (newManagerId) {
      const u = await this.prisma.user.findUnique({ where: { id: newManagerId } });
      if (!u) throw new BadRequestException('Менеджер не найден');
    }
    return this.prisma.application.update({
      where: { id: applicationId },
      data: { managerId: newManagerId },
      include: { manager: { select: { id: true, fullName: true, role: true } } },
    });
  }

  // ===== Pipelines =====

  async listPipelines() {
    return this.prisma.pipeline.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { stages: { orderBy: { order: 'asc' } } },
    });
  }

  async createPipeline(data: {
    name: string;
    description?: string;
    isDefault?: boolean;
    stages?: { name: string; color?: string; isClosingStage?: boolean }[];
  }) {
    if (!data.name?.trim()) throw new BadRequestException('Название обязательно');
    if (data.isDefault) {
      await this.prisma.pipeline.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    return this.prisma.pipeline.create({
      data: {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        isDefault: !!data.isDefault,
        stages: {
          create: (data.stages || []).map((s, i) => ({
            name: s.name,
            order: i,
            color: s.color || null,
            isClosingStage: !!s.isClosingStage,
          })),
        },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
  }

  async updatePipeline(
    id: string,
    patch: { name?: string; description?: string; isDefault?: boolean; isActive?: boolean },
  ) {
    if (patch.isDefault === true) {
      await this.prisma.pipeline.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    return this.prisma.pipeline.update({ where: { id }, data: patch });
  }

  async deletePipeline(id: string) {
    await this.prisma.pipeline.delete({ where: { id } });
    return { ok: true };
  }

  async addStage(pipelineId: string, data: { name: string; color?: string; isClosingStage?: boolean }) {
    const last = await this.prisma.pipelineStage.findFirst({
      where: { pipelineId },
      orderBy: { order: 'desc' },
    });
    return this.prisma.pipelineStage.create({
      data: {
        pipelineId,
        name: data.name,
        order: (last?.order ?? -1) + 1,
        color: data.color || null,
        isClosingStage: !!data.isClosingStage,
      },
    });
  }

  async updateStage(id: string, patch: { name?: string; order?: number; color?: string; isClosingStage?: boolean }) {
    return this.prisma.pipelineStage.update({ where: { id }, data: patch });
  }

  async deleteStage(id: string) {
    await this.prisma.pipelineStage.delete({ where: { id } });
    return { ok: true };
  }
}
