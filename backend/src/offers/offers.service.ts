import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_OFFER = `# Оферта сотрудника Javonon

Внимательно прочтите перед подтверждением.

## 1. Общие положения
Настоящая оферта регулирует отношения между сотрудником и компанией
Javonon Group.

## 2. Обязанности сотрудника
- Соблюдать рабочий график.
- Бережно относиться к данным клиентов.
- Не разглашать коммерческую тайну.

## 3. Оплата труда
Заработная плата начисляется по модели «фикс + почасовая + бонус %» —
актуальная формула отражена в карточке сотрудника.

## 4. Расторжение
Договор может быть расторгнут любой из сторон с уведомлением за 14
календарных дней.

---
Подписывая оферту, вы подтверждаете, что ознакомились с условиями и
согласны с ними.`;

@Injectable()
export class OffersService {
  constructor(private prisma: PrismaService) {}

  /**
   * Активная оферта + статус подписи для текущего пользователя.
   * Если активных нет — создаём дефолтную (FOUNDER потом отредактирует).
   */
  async current(userId: string) {
    let offer = await this.prisma.offerTemplate.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!offer) {
      offer = await this.prisma.offerTemplate.create({
        data: { title: 'Оферта сотрудника', content: DEFAULT_OFFER, version: 1 },
      });
    }
    const signature = await this.prisma.offerSignature.findUnique({
      where: { userId_offerId: { userId, offerId: offer.id } },
    });
    return {
      offer,
      signed: !!signature,
      signedAt: signature?.signedAt ?? null,
    };
  }

  /** Подписать оферту. Идемпотентно — повторно вернёт существующую подпись. */
  async sign(userId: string, offerId: string, ctx: { ip?: string; userAgent?: string }) {
    const offer = await this.prisma.offerTemplate.findUnique({ where: { id: offerId } });
    if (!offer) throw new NotFoundException('Оферта не найдена');
    if (!offer.isActive) throw new BadRequestException('Эту версию оферты больше нельзя подписать');

    const existing = await this.prisma.offerSignature.findUnique({
      where: { userId_offerId: { userId, offerId } },
    });
    if (existing) return existing;

    return this.prisma.offerSignature.create({
      data: {
        userId, offerId,
        ip: ctx.ip || null,
        userAgent: ctx.userAgent || null,
      },
    });
  }

  /** Все офёрты — для FOUNDER/ADMIN. */
  async list() {
    return this.prisma.offerTemplate.findMany({
      orderBy: { version: 'desc' },
      include: { _count: { select: { signatures: true } } },
    });
  }

  /**
   * Создать новую версию оферты. Делает старую активную неактивной.
   * Версия инкрементируется автоматически.
   */
  async createNew(data: { title?: string; content: string }) {
    if (!data.content || !data.content.trim()) {
      throw new BadRequestException('Текст оферты не может быть пустым');
    }
    await this.prisma.offerTemplate.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });
    const last = await this.prisma.offerTemplate.findFirst({
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return this.prisma.offerTemplate.create({
      data: {
        title: data.title || 'Оферта сотрудника',
        content: data.content.trim(),
        version: (last?.version || 0) + 1,
        isActive: true,
      },
    });
  }

  /** Обновить текст ТЕКУЩЕЙ версии (если ещё никто не подписал). */
  async patch(id: string, data: { title?: string; content?: string }) {
    const offer = await this.prisma.offerTemplate.findUnique({
      where: { id },
      include: { _count: { select: { signatures: true } } },
    });
    if (!offer) throw new NotFoundException('Оферта не найдена');
    if (offer._count.signatures > 0) {
      throw new BadRequestException(
        'Эту версию уже подписали. Создай новую вместо редактирования.',
      );
    }
    return this.prisma.offerTemplate.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.content !== undefined && { content: data.content.trim() }),
      },
    });
  }

  /** Подписи по конкретной оферте — для аудита. */
  async signatures(offerId: string) {
    return this.prisma.offerSignature.findMany({
      where: { offerId },
      include: { user: { select: { id: true, fullName: true, email: true } } },
      orderBy: { signedAt: 'desc' },
    });
  }

  /**
   * Удалить версию оферты (ТЗ §1 «полный CRUD»). Запрещено для версий с
   * подписями — там идёт audit trail. Если оферта была isActive=true —
   * автоматически активируем предыдущую по version.
   */
  async remove(id: string) {
    const offer = await this.prisma.offerTemplate.findUnique({
      where: { id },
      include: { _count: { select: { signatures: true } } },
    });
    if (!offer) throw new NotFoundException('Оферта не найдена');
    if (offer._count.signatures > 0) {
      throw new BadRequestException(
        'Нельзя удалить версию с подписями. Деактивируй её (она останется в архиве).',
      );
    }
    await this.prisma.offerTemplate.delete({ where: { id } });
    // Если удалили активную — поднимаем предыдущую активной.
    if (offer.isActive) {
      const prev = await this.prisma.offerTemplate.findFirst({
        orderBy: { version: 'desc' },
      });
      if (prev) {
        await this.prisma.offerTemplate.update({
          where: { id: prev.id },
          data: { isActive: true },
        });
      }
    }
    return { ok: true };
  }
}
