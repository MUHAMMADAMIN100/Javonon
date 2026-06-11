import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const VALID_ROLES: Role[] = ['FOUNDER', 'ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER'];

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
    // По ТЗ §1 — оферта своя для каждой роли. Ищем активную для
    // primary роли юзера; если нет — fallback на «общую» (role=null),
    // которая работает как универсальный шаблон.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    let offer = null as any;
    if (user?.role) {
      offer = await this.prisma.offerTemplate.findFirst({
        where: { isActive: true, role: user.role },
        orderBy: { version: 'desc' },
      });
    }
    if (!offer) {
      offer = await this.prisma.offerTemplate.findFirst({
        where: { isActive: true, role: null },
        orderBy: { version: 'desc' },
      });
    }
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
  async createNew(data: { title?: string; content: string; role?: Role | null }) {
    this.validateOfferFields(data);
    // Validate role explicitly: null = «общая» оферта, иначе должен быть
    // один из 5 ТЗ-ролей.
    let role: Role | null = null;
    if (data.role !== undefined && data.role !== null) {
      if (!VALID_ROLES.includes(data.role)) {
        throw new BadRequestException(`role должен быть один из: ${VALID_ROLES.join(', ')} или null`);
      }
      role = data.role;
    }
    // Деактивируем только версии ДЛЯ ЭТОЙ ЖЕ роли. Раньше деактивировали
    // ВСЕ активные — после внедрения role-specific офёрт это бы убивало
    // оферту для других ролей при создании новой для одной роли.
    await this.prisma.offerTemplate.updateMany({
      where: { isActive: true, role },
      data: { isActive: false },
    });
    // Version — глобальный счётчик независимо от роли, проще для
    // адмиx-страницы (видна общая хронология).
    const last = await this.prisma.offerTemplate.findFirst({
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return this.prisma.offerTemplate.create({
      data: {
        title: (data.title || 'Оферта сотрудника').trim(),
        content: data.content.trim(),
        version: (last?.version || 0) + 1,
        isActive: true,
        role,
      },
    });
  }

  /**
   * Валидация полей оферты. Раньше офис-контроллер принимал `body: {
   * title?, content }` без class-validator — admin мог сохранить
   * 10MB строку (DB bloat) или `<script>` в title (попадает в audit-
   * логи / Telegram-уведомления с html_mode).
   */
  private validateOfferFields(data: { title?: string; content?: string }) {
    if (data.title !== undefined) {
      const t = data.title.trim();
      if (t.length > 200) {
        throw new BadRequestException('Заголовок оферты слишком длинный (макс. 200 символов)');
      }
      if (/[<>]/.test(t)) {
        throw new BadRequestException('Заголовок оферты не должен содержать HTML-теги');
      }
    }
    if (data.content !== undefined) {
      if (!data.content.trim()) {
        throw new BadRequestException('Текст оферты не может быть пустым');
      }
      if (data.content.length > 100_000) {
        throw new BadRequestException('Текст оферты слишком длинный (макс. 100000 символов)');
      }
    }
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
    this.validateOfferFields(data);
    return this.prisma.offerTemplate.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title.trim() }),
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
    // Если удалили активную — поднимаем предыдущую активной для ТОЙ ЖЕ
    // роли. Без фильтра на роль удаление активной CLIENT_MANAGER-оферты
    // могло «активировать» ADMIN-версию по версии, что путало UI.
    if (offer.isActive) {
      const prev = await this.prisma.offerTemplate.findFirst({
        where: { role: offer.role },
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
