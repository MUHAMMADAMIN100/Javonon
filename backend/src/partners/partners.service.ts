import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { resolveLandingBaseUrl } from '../common/landing-url';
import { AdminPartnerCreateDto } from './dto/admin-partner.dto';

// Без I/O/0/1 — чтобы код не путался в письме, звонке, скриншоте.
// 32 символа = ровно 5 бит на позицию.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Пароль для авто-генерации: A-Z без I/O + a-z без i/l/o + цифры без 0/1.
const PW_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

@Injectable()
export class PartnersService {
  constructor(private prisma: PrismaService) {}

  /** 6-символьный ref-код из безопасного алфавита (без I, O, 0, 1). */
  private genReferralCode(): string {
    // crypto.randomInt — CSPRNG (Node built-in). Math.random (V8 xorshift128+)
    // допускает state-recovery по нескольким выходам → предсказуемые коды
    // и, что важнее, предсказуемые авто-пароли из того же process.
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
    }
    return out;
  }

  /** До 5 попыток на коллизию unique-constraint. */
  private async createUniqueReferralCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = this.genReferralCode();
      const exists = await this.prisma.partner.findUnique({
        where: { referralCode: code },
      });
      if (!exists) return code;
    }
    throw new InternalServerErrorException(
      'Не удалось сгенерировать уникальный ref-код после 5 попыток',
    );
  }

  private genPassword(len = 12): string {
    // Обязательно CSPRNG: этот пароль возвращается FOUNDER/ADMIN и
    // напрямую используется для bcrypt.hash. Math.random в V8 —
    // xorshift128+, state восстанавливается из ~5 последовательных
    // выходов, что позволило бы предсказать пароли других партнёров,
    // созданных из того же процесса.
    let out = '';
    for (let i = 0; i < len; i++) {
      out += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
    }
    return out;
  }

  /**
   * Реферальная ссылка партнёра. Base берём ТОЛЬКО из resolveLandingBaseUrl —
   * раньше здесь была своя env-цепочка с дефолтом 'https://javonon.com',
   * который не резолвится в DNS, и партнёрам уезжала битая ссылка.
   *
   * Фрагмент #apply обязателен: лендинг длинный, форма заявки внизу, и без
   * якоря приглашённый попадал на первый экран — конверсия по партнёрским
   * переходам проседала. Фрагмент строго последним: всё после '#' в query
   * уже не попадает.
   */
  private buildReferralUrl(code: string): string {
    const base = resolveLandingBaseUrl();
    return `${base}/?ref=${code}#apply`;
  }

  private toPublicPartner(p: any) {
    const { password, ...rest } = p;
    return rest;
  }

  /** Дашборд партнёра: ссылка, статистика воронки, баланс. */
  async dashboard(partnerId: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
    });
    if (!partner) throw new NotFoundException('Партнёр не найден');

    const [clicks, attributions, commissions] = await Promise.all([
      this.prisma.referralClick.count({ where: { partnerId } }),
      this.prisma.referralAttribution.count({ where: { partnerId } }),
      this.prisma.commission.findMany({
        where: { partnerId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const paidCount = commissions.filter((c) => c.status === 'PAID').length;
    const pendingCount = commissions.filter((c) => c.status !== 'PAID').length;

    return {
      partner: {
        id: partner.id,
        fullName: partner.fullName,
        email: partner.email,
        referralCode: partner.referralCode,
        commissionPct: partner.commissionPct,
        balanceCents: partner.balanceCents,
        totalEarnedCents: partner.totalEarnedCents,
        totalPaidCents: partner.totalPaidCents,
      },
      stats: {
        clicks,
        leads: attributions,
        sales: paidCount + pendingCount,
        paidSales: paidCount,
      },
      recentCommissions: commissions,
    };
  }

  async listCommissions(partnerId: string, params?: { limit?: number }) {
    const limit = Math.min(params?.limit || 50, 200);
    return this.prisma.commission.findMany({
      where: { partnerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async requestPayout(partnerId: string, body: {
    amountCents: number;
    method?: string;
    details?: string;
  }) {
    const amount = Math.floor(body.amountCents || 0);
    if (amount <= 0) throw new BadRequestException('Сумма должна быть > 0');
    if (amount > 100_000_000) {
      throw new BadRequestException('Сумма слишком большая');
    }
    // method и details — partner-controlled. Попадают в админ-дашборд.
    // Раньше принимали любую строку → stored XSS в админ UI + DB bloat
    // через гигантский details.
    const VALID_METHODS = new Set(['bank_card', 'bank_transfer', 'crypto', 'cash', 'other']);
    let method: string | null = null;
    if (body.method) {
      const m = body.method.toLowerCase().trim();
      if (!VALID_METHODS.has(m)) {
        throw new BadRequestException(`method должен быть один из: ${[...VALID_METHODS].join(', ')}`);
      }
      method = m;
    }
    let details: string | null = null;
    if (body.details) {
      const d = body.details.trim();
      if (d.length > 500) throw new BadRequestException('details слишком длинные (макс. 500)');
      if (/[<>]/.test(d)) throw new BadRequestException('details не должны содержать HTML-теги');
      details = d || null;
    }

    // АТОМАРНО: проверка баланса + decrement + создание payout в одной
    // транзакции. Раньше check был ПЕРЕД tx → две параллельные requestPayout
    // могли пройти проверку до tx и обе списать → отрицательный баланс.
    // Теперь используем updateMany с where: balanceCents >= amount —
    // если другая параллельная транзакция успела первой, count=0 и мы
    // выбрасываем ошибку.
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.partner.updateMany({
        where: { id: partnerId, balanceCents: { gte: amount } },
        data: { balanceCents: { decrement: amount } },
      });
      if (claim.count === 0) {
        // Либо партнёр не найден, либо недостаточно средств
        const exists = await tx.partner.findUnique({ where: { id: partnerId } });
        if (!exists) throw new NotFoundException('Партнёр не найден');
        throw new BadRequestException('Недостаточно средств на балансе');
      }
      const payout = await tx.partnerPayout.create({
        data: {
          partnerId,
          amountCents: amount,
          method,
          details,
        },
      });
      return payout;
    });
  }

  async listPayouts(partnerId: string) {
    return this.prisma.partnerPayout.findMany({
      where: { partnerId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  // ===== Admin operations =====

  /**
   * Список партнёров для админки. Возвращаем referralUrl на КАЖДОГО партнёра,
   * а не только referralCode: CRM собирала ссылку сама (свой fallback-домен,
   * без '#apply'), и один и тот же партнёр показывал разные ссылки в списке и
   * в карточке. Ссылку строит только backend — buildReferralUrl здесь тот же,
   * что в adminCreate и adminGetOne.
   *
   * Prisma select не умеет вычисляемые поля, поэтому клеим их после выборки.
   */
  async adminList() {
    const partners = await this.prisma.partner.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        referralCode: true,
        // commissionPct оставлен для legacy-фронтов; canonical поле —
        // commissionAmountCents (Variant A flat-rate).
        commissionPct: true,
        commissionAmountCents: true,
        balanceCents: true,
        totalEarnedCents: true,
        totalPaidCents: true,
        status: true,
        telegramHandle: true,
        createdAt: true,
        _count: {
          select: { clicks: true, attributions: true, commissions: true },
        },
      },
    });

    return partners.map((p) => ({
      ...p,
      referralUrl: this.buildReferralUrl(p.referralCode),
    }));
  }

  /**
   * FOUNDER/ADMIN создаёт партнёра вручную. Пароль опциональный — если
   * не задан, backend генерирует 12-char alnum и возвращает plainPassword
   * ОДИН РАЗ в ответе. Хэш сохраняется через bcrypt (10 раундов —
   * согласовано с partner-auth.service.ts).
   */
  async adminCreate(dto: AdminPartnerCreateDto) {
    // DTO уже нормализовал email/fullName/phone/password через @Transform.
    const email = dto.email;
    const fullName = dto.fullName;
    const phone = dto.phone || null;
    // Variant A flat-rate: сохраняем commissionAmountCents (TJS × 100).
    // Дефолт 500 TJS если dto не задан. commissionPct из dto ПРИНИМАЕМ,
    // но игнорируем (legacy).
    const amountTjs =
      typeof dto.commissionAmountTjs === 'number'
        ? Math.max(0, Math.min(100000, Math.floor(dto.commissionAmountTjs)))
        : 500;
    const commissionAmountCents = amountTjs * 100;

    // Ранняя проверка — чтобы отдать 409 без бесполезной работы по
    // хэшу пароля и генерации ref-кода.
    const existing = await this.prisma.partner.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email уже зарегистрирован');

    let plainPassword: string | undefined;
    let rawPassword = dto.password;
    if (!rawPassword) {
      plainPassword = this.genPassword(12);
      rawPassword = plainPassword;
    }
    const passwordHash = await bcrypt.hash(rawPassword, 10);
    const referralCode = await this.createUniqueReferralCode();

    let partner;
    try {
      partner = await this.prisma.partner.create({
        data: {
          email,
          password: passwordHash,
          fullName,
          phone,
          referralCode,
          commissionAmountCents,
        },
      });
    } catch (e: any) {
      // Race: параллельный adminCreate с тем же email проскочил ранний check.
      if (e?.code === 'P2002') {
        const target: string[] = e?.meta?.target || [];
        if (target.includes('email')) {
          throw new ConflictException('Email уже зарегистрирован');
        }
        // Гонка по referralCode — крайне маловероятна, но не будем врать.
        throw new InternalServerErrorException(
          'Конфликт уникальности при создании партнёра — повтори попытку',
        );
      }
      throw e;
    }

    return {
      partner: this.toPublicPartner(partner),
      referralUrl: this.buildReferralUrl(partner.referralCode),
      ...(plainPassword ? { plainPassword } : {}),
    };
  }

  /**
   * Удаление партнёра. Если есть история (Commission или ReferralAttribution) —
   * soft delete (status=BANNED), чтобы сохранить audit trail для будущих
   * споров по бонусам. Иначе — hard delete (Cascade по FK на schema).
   */
  async adminDelete(id: string) {
    const partner = await this.prisma.partner.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException('Партнёр не найден');

    const [commissionsCount, attributionsCount] = await Promise.all([
      this.prisma.commission.count({ where: { partnerId: id } }),
      this.prisma.referralAttribution.count({ where: { partnerId: id } }),
    ]);

    if (commissionsCount > 0 || attributionsCount > 0) {
      const updated = await this.prisma.partner.update({
        where: { id },
        data: { status: 'BANNED' },
      });
      return { softDeleted: true, partner: this.toPublicPartner(updated) };
    }

    await this.prisma.partner.delete({ where: { id } });
    return { hardDeleted: true, id };
  }

  async adminUpdate(id: string, patch: {
    // LEGACY: принимаем commissionPct для обратной совместимости старых
    // клиентов, но НЕ пишем его в БД — расчёт перешёл на flat-rate.
    commissionPct?: number;
    // Variant A: новая ставка в TJS (сервис переведёт в копейки).
    commissionAmountTjs?: number;
    status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
    fullName?: string;
  }) {
    return this.prisma.partner.update({
      where: { id },
      data: {
        ...(typeof patch.commissionAmountTjs === 'number' && {
          commissionAmountCents:
            Math.max(0, Math.min(100000, Math.floor(patch.commissionAmountTjs))) *
            100,
        }),
        ...(patch.status && { status: patch.status }),
        ...(patch.fullName && { fullName: patch.fullName }),
      },
    });
  }

  async adminListCommissions(params?: {
    partnerId?: string;
    status?: 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED';
  }) {
    return this.prisma.commission.findMany({
      where: {
        ...(params?.partnerId && { partnerId: params.partnerId }),
        ...(params?.status && { status: params.status }),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        partner: { select: { id: true, fullName: true, email: true } },
      },
    });
  }

  /**
   * Хэлпер: подтягивает связанные Application/Student к атрибуциям.
   * ReferralAttribution хранит только studentId/applicationId как String? —
   * без FK-relation в Prisma-схеме, поэтому include не работает, делаем
   * batch-fetch с in-запросами.
   */
  private async hydrateAttributions(
    attrs: Array<{
      id: string;
      createdAt: Date;
      source: string;
      studentId: string | null;
      applicationId: string | null;
      telegramUserId: string | null;
      emailHint: string | null;
    }>,
  ) {
    const appIds = attrs
      .map((a) => a.applicationId)
      .filter((x): x is string => !!x);
    const studentIds = attrs
      .map((a) => a.studentId)
      .filter((x): x is string => !!x);

    const applications = appIds.length
      ? await this.prisma.application.findMany({
          where: { id: { in: appIds } },
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
            direction: true,
            status: true,
            createdAt: true,
          },
        })
      : [];
    const students = studentIds.length
      ? await this.prisma.student.findMany({
          where: { id: { in: studentIds } },
          select: {
            id: true,
            fullName: true,
            phones: true,
            email: true,
          },
        })
      : [];

    const appMap = new Map(applications.map((a) => [a.id, a]));
    const studentMap = new Map(students.map((s) => [s.id, s]));

    return attrs.map((a) => {
      let student:
        | { id: string; fullName: string; phone: string | null; email: string | null }
        | null = null;
      if (a.studentId) {
        const s = studentMap.get(a.studentId);
        if (s) {
          student = {
            id: s.id,
            fullName: s.fullName,
            phone: s.phones && s.phones.length > 0 ? s.phones[0] : null,
            email: s.email,
          };
        }
      }
      return {
        id: a.id,
        createdAt: a.createdAt,
        source: a.source,
        application: a.applicationId ? appMap.get(a.applicationId) || null : null,
        student,
        telegramUserId: a.telegramUserId,
        emailHint: a.emailHint,
      };
    });
  }

  /**
   * Полная карточка партнёра для админ-панели: базовые поля, реферальная
   * ссылка (тот же env-fallback, что и в adminCreate — через buildReferralUrl),
   * агрегированная статистика (счётчики) и последние 20 кликов + 10
   * атрибуций для превью в шапке.
   */
  async adminGetOne(id: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        referralCode: true,
        // commissionPct — legacy, отдаём для обратной совместимости.
        // commissionAmountCents — canonical (Variant A flat-rate).
        commissionPct: true,
        commissionAmountCents: true,
        status: true,
        balanceCents: true,
        totalEarnedCents: true,
        totalPaidCents: true,
        createdAt: true,
        updatedAt: true,
        telegramHandle: true,
        telegramId: true,
      },
    });
    if (!partner) throw new NotFoundException('Партнёр не найден');

    const [
      clicksCount,
      attributionsCount,
      commissionsCount,
      payoutsCount,
      recentClicks,
      recentAttributionsRaw,
    ] = await Promise.all([
      this.prisma.referralClick.count({ where: { partnerId: id } }),
      this.prisma.referralAttribution.count({ where: { partnerId: id } }),
      this.prisma.commission.count({ where: { partnerId: id } }),
      this.prisma.partnerPayout.count({ where: { partnerId: id } }),
      this.prisma.referralClick.findMany({
        where: { partnerId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          createdAt: true,
          source: true,
          ip: true,
          userAgent: true,
          referer: true,
        },
      }),
      this.prisma.referralAttribution.findMany({
        where: { partnerId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          createdAt: true,
          source: true,
          studentId: true,
          applicationId: true,
          telegramUserId: true,
          emailHint: true,
        },
      }),
    ]);

    const recentAttributions = await this.hydrateAttributions(
      recentAttributionsRaw,
    );

    return {
      partner,
      referralUrl: this.buildReferralUrl(partner.referralCode),
      stats: {
        clicksCount,
        attributionsCount,
        commissionsCount,
        payoutsCount,
      },
      recentClicks,
      recentAttributions,
    };
  }

  /**
   * Пагинированный список атрибуций конкретного партнёра. take clamped
   * контроллером; здесь просто forward. Возвращаем total чтобы UI мог
   * отрисовать пагинацию, и hasMore для infinite scroll.
   */
  async adminGetAttributions(id: string, take: number, skip: number) {
    const partner = await this.prisma.partner.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!partner) throw new NotFoundException('Партнёр не найден');

    const [rawItems, total] = await Promise.all([
      this.prisma.referralAttribution.findMany({
        where: { partnerId: id },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          createdAt: true,
          source: true,
          studentId: true,
          applicationId: true,
          telegramUserId: true,
          emailHint: true,
        },
      }),
      this.prisma.referralAttribution.count({ where: { partnerId: id } }),
    ]);

    const items = await this.hydrateAttributions(rawItems);
    return {
      items,
      total,
      hasMore: skip + items.length < total,
    };
  }

  async adminMarkCommissionPaid(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.commission.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Начисление не найдено');
      if (c.status === 'PAID') return c;
      const updated = await tx.commission.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date(), approvedAt: new Date() },
      });
      // Сдвигаем баланс: убираем из balanceCents (выплачено), записываем
      // в totalPaidCents.
      await tx.partner.update({
        where: { id: c.partnerId },
        data: {
          balanceCents: { decrement: c.amountCents },
          totalPaidCents: { increment: c.amountCents },
        },
      });
      return updated;
    });
  }

  async adminListPayouts(params?: { partnerId?: string }) {
    return this.prisma.partnerPayout.findMany({
      where: {
        ...(params?.partnerId && { partnerId: params.partnerId }),
      },
      orderBy: { requestedAt: 'desc' },
      take: 500,
      include: {
        partner: { select: { id: true, fullName: true, email: true } },
      },
    });
  }

  async adminMarkPayout(id: string, action: 'paid' | 'rejected') {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.partnerPayout.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Выплата не найдена');
      if (p.status !== 'REQUESTED') {
        throw new ForbiddenException('Этот payout уже обработан');
      }
      if (action === 'paid') {
        return tx.partnerPayout.update({
          where: { id },
          data: { status: 'PAID', paidAt: new Date() },
        });
      } else {
        // Возвращаем зарезервированную сумму на баланс
        await tx.partner.update({
          where: { id: p.partnerId },
          data: { balanceCents: { increment: p.amountCents } },
        });
        return tx.partnerPayout.update({
          where: { id },
          data: { status: 'REJECTED', rejectedAt: new Date() },
        });
      }
    });
  }
}
