import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Direction, Prisma, Program, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProgramDto } from './dto/create-program.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TelegramService } from '../telegram/telegram.service';
import { isElevated } from '../auth/role-utils';

type CurrentUser = { id: string; role: Role; roles?: Role[] };

const DIRECTION_LABEL: Record<Direction, string> = {
  BACHELOR: 'Бакалавриат',
  MASTER: 'Магистратура',
  LANGUAGE: 'Языковые курсы',
  LANGUAGE_COLLEGE: 'Языковой + колледж',
  LANGUAGE_BACHELOR: 'Языковой + бакалавриат',
  COLLEGE: 'Колледж',
};

@Injectable()
export class ProgramsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private telegram: TelegramService,
    private config: ConfigService,
  ) {}

  async findAll(filters: {
    city?: string;
    major?: string;
    direction?: Direction;
    minCost?: number;
    maxCost?: number;
    search?: string;
    publishedOnly?: boolean;
  }) {
    const where: Prisma.ProgramWhereInput = {};
    if (filters.city) where.city = { contains: filters.city, mode: 'insensitive' };
    if (filters.major) where.major = { contains: filters.major, mode: 'insensitive' };
    if (filters.direction) where.direction = filters.direction;
    if (typeof filters.minCost === 'number' || typeof filters.maxCost === 'number') {
      where.cost = {};
      if (typeof filters.minCost === 'number') (where.cost as any).gte = filters.minCost;
      if (typeof filters.maxCost === 'number') (where.cost as any).lte = filters.maxCost;
    }
    if (filters.publishedOnly) where.published = true;
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { university: { contains: filters.search, mode: 'insensitive' } },
        { major: { contains: filters.search, mode: 'insensitive' } },
        { city: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.program.findMany({
      where,
      orderBy: [{ published: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: string) {
    const p = await this.prisma.program.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Программа не найдена');
    return p;
  }

  async create(dto: CreateProgramDto, user: CurrentUser) {
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Только администратор может создавать программы');
    }
    const program = await this.prisma.program.create({
      data: {
        name: dto.name.trim(),
        university: dto.university.trim(),
        // ТЗ-доработка: city/major/direction/cost — опциональны.
        // direction по умолчанию BACHELOR если не задано, cost 0 = бесплатно.
        city: dto.city?.trim() || '',
        major: dto.major?.trim() || '',
        direction: dto.direction || 'BACHELOR',
        cost: dto.cost ?? 0,
        currency: dto.currency || 'CNY',
        duration: dto.duration || null,
        language: dto.language || null,
        description: dto.description || null,
        imageUrl: dto.imageUrl || null,
        universityWebsiteUrl: dto.universityWebsiteUrl?.trim() || null,
        published: dto.published ?? true,
        englishLevel: dto.englishLevel?.trim() || null,
        hasGrant: dto.hasGrant ?? false,
        grantDetails: dto.grantDetails?.trim() || null,
        grantEnglishLevel: dto.grantEnglishLevel?.trim() || null,
        avgAdmissionScore: dto.avgAdmissionScore?.trim() || null,
        applicationDeadline: dto.applicationDeadline?.trim() || null,
        intakesPerYear: dto.intakesPerYear ?? null,
      },
    });

    this.realtime.emitStaff('program:new', { program });
    this.realtime.emitAllStudents('program:new', { program });

    // Шлём в канал и сохраняем message_id для последующего edit/delete
    this.notifyChannelNew(program).catch(() => undefined);

    return program;
  }

  async update(id: string, dto: UpdateProgramDto, user: CurrentUser) {
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Только администратор может редактировать программы');
    }
    const existing = await this.findOne(id);
    const updated = await this.prisma.program.update({ where: { id }, data: dto });

    this.realtime.emitStaff('program:updated', { program: updated });
    this.realtime.emitAllStudents('program:updated', { program: updated });

    // Если у программы был пост в канале — обновляем его
    if (existing.telegramMessageId) {
      const imageChanged = existing.imageUrl !== updated.imageUrl;
      this.notifyChannelUpdate(updated, imageChanged).catch(() => undefined);
    } else if (updated.published) {
      // Если поста ещё не было (например, программа была не published) — создаём сейчас
      this.notifyChannelNew(updated).catch(() => undefined);
    }

    return updated;
  }

  async remove(id: string, user: CurrentUser) {
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Только администратор может удалять программы');
    }
    const existing = await this.findOne(id);

    // Сначала пытаемся удалить пост в канале (пока запись ещё есть, есть message_id)
    if (existing.telegramMessageId) {
      await this.notifyChannelDelete(existing).catch(() => undefined);
    }

    await this.prisma.program.delete({ where: { id } });

    this.realtime.emitStaff('program:deleted', { id });
    this.realtime.emitAllStudents('program:deleted', { id });

    return { ok: true };
  }

  async filters() {
    const [cities, majors] = await Promise.all([
      this.prisma.program.findMany({
        where: { published: true },
        select: { city: true },
        distinct: ['city'],
        orderBy: { city: 'asc' },
      }),
      this.prisma.program.findMany({
        where: { published: true },
        select: { major: true },
        distinct: ['major'],
        orderBy: { major: 'asc' },
      }),
    ]);
    return {
      cities: cities.map((c) => c.city),
      majors: majors.map((m) => m.major),
    };
  }

  private buildCaption(program: Program, header = '🎓 *Новая программа на Javonon*'): string {
    return (
      `${header}\n\n` +
      `📚 *${this.escape(program.name)}*\n` +
      `🏛 ${this.escape(program.university)}\n` +
      `📍 ${this.escape(program.city)}\n` +
      `🎯 ${this.escape(program.major)} · ${DIRECTION_LABEL[program.direction]}\n` +
      (program.duration ? `⏱ ${this.escape(program.duration)}\n` : '') +
      (program.language ? `🌐 ${this.escape(program.language)}\n` : '') +
      `\n💰 Стоимость: *${program.cost.toLocaleString('ru-RU')} ${program.currency}* / год\n` +
      (program.description ? `\n${this.escape(program.description.slice(0, 600))}` : '')
    );
  }

  private buildPhotoUrl(program: Program): string | null {
    if (!program.imageUrl) return null;
    if (program.imageUrl.startsWith('http')) return program.imageUrl;
    const publicBase = this.config.get<string>('PUBLIC_API_BASE');
    return publicBase ? `${publicBase}${program.imageUrl}` : null;
  }

  private async notifyChannelNew(program: Program) {
    if (!program.published) return;
    const caption = this.buildCaption(program);
    const photoUrl = this.buildPhotoUrl(program);

    let messageId: number | null = null;
    let hasPhoto = false;

    if (photoUrl) {
      const res = await this.telegram.sendPhotoToChannel(photoUrl, caption);
      if (res) {
        messageId = res.messageId;
        hasPhoto = res.hasPhoto;
      }
    } else {
      messageId = await this.telegram.sendToChannel(caption);
      hasPhoto = false;
    }

    if (messageId) {
      await this.prisma.program.update({
        where: { id: program.id },
        data: { telegramMessageId: messageId, telegramHasPhoto: hasPhoto },
      });
    }
  }

  private async notifyChannelUpdate(program: Program, imageChanged: boolean) {
    if (!program.telegramMessageId) return;
    const caption = this.buildCaption(program, '🎓 *Программа Javonon*');
    const photoUrl = this.buildPhotoUrl(program);

    // Если картинка не менялась — просто обновляем подпись/текст и выходим.
    // editMessageMedia с тем же URL Telegram ругает "message is not modified".
    if (!imageChanged) {
      if (program.telegramHasPhoto) {
        await this.telegram.editChannelCaption(program.telegramMessageId, caption);
      } else {
        await this.telegram.editChannelText(program.telegramMessageId, caption);
      }
      return;
    }

    // Картинка поменялась. Самый надёжный путь — удалить старое сообщение и
    // отправить новое (Telegram editMessageMedia плохо работает с разной
    // топологией: текст<->фото, подмена URL, etc.). Сохраняем новый messageId.
    await this.repostChannel(program, caption, photoUrl);
  }

  private async repostChannel(program: Program, caption: string, photoUrl: string | null) {
    if (!program.telegramMessageId) return;
    await this.telegram.deleteChannelMessage(program.telegramMessageId);

    let newId: number | null = null;
    let hasPhoto = false;
    if (photoUrl) {
      const res = await this.telegram.sendPhotoToChannel(photoUrl, caption);
      if (res) {
        newId = res.messageId;
        hasPhoto = res.hasPhoto;
      }
    } else {
      newId = await this.telegram.sendToChannel(caption);
      hasPhoto = false;
    }

    if (newId) {
      await this.prisma.program.update({
        where: { id: program.id },
        data: { telegramMessageId: newId, telegramHasPhoto: hasPhoto },
      });
    }
  }

  private async notifyChannelDelete(program: Program) {
    if (!program.telegramMessageId) return;
    const ok = await this.telegram.deleteChannelMessage(program.telegramMessageId);
    if (ok) return;
    // Не получилось удалить (старше 48 часов / нет прав) — помечаем пост
    const cancelled =
      `~${this.escape(program.name)}~\n\n❌ *Программа снята с публикации*`;
    if (program.telegramHasPhoto) {
      await this.telegram.editChannelCaption(program.telegramMessageId, cancelled);
    } else {
      await this.telegram.editChannelText(program.telegramMessageId, cancelled);
    }
  }

  private escape(s: string): string {
    // Экранируем Markdown-символы, ломающие parse_mode=Markdown
    return s.replace(/([_*[\]`])/g, '\\$1');
  }
}
