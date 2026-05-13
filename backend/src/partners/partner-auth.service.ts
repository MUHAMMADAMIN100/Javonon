import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Простая alphabet для ref-кодов: исключены неоднозначные 0/O/1/l/I,
 * чтобы партнёр мог продиктовать код голосом без ошибок.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateCode(len = 8): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

@Injectable()
export class PartnerAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  private async signFor(partner: { id: string; email: string }) {
    const secret =
      this.config.get<string>('PARTNER_JWT_SECRET') ||
      this.config.get<string>('JWT_SECRET') ||
      'fallback-secret';
    return this.jwt.signAsync(
      { sub: partner.id, email: partner.email, role: 'PARTNER' },
      { secret, expiresIn: this.config.get<string>('JWT_EXPIRES_IN') || '30d' },
    );
  }

  private async uniqueCode(): Promise<string> {
    // Пытаемся максимум 5 раз сгенерировать неконфликтующий код.
    for (let i = 0; i < 5; i++) {
      const code = generateCode();
      const exists = await this.prisma.partner.findUnique({
        where: { referralCode: code },
      });
      if (!exists) return code;
    }
    throw new Error('Не удалось сгенерировать уникальный ref-код');
  }

  async register(input: {
    email: string;
    password: string;
    fullName: string;
    phone?: string;
  }) {
    const email = (input.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Некорректный email');
    }
    if (!input.password || input.password.length < 6) {
      throw new BadRequestException('Пароль минимум 6 символов');
    }
    if (!input.fullName || input.fullName.trim().length < 2) {
      throw new BadRequestException('Укажи имя');
    }
    const exists = await this.prisma.partner.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email уже зарегистрирован');

    const password = await bcrypt.hash(input.password, 10);
    const referralCode = await this.uniqueCode();

    const partner = await this.prisma.partner.create({
      data: {
        email,
        password,
        fullName: input.fullName.trim(),
        phone: input.phone?.trim() || null,
        referralCode,
      },
    });

    const token = await this.signFor(partner);
    return { token, partner: this.toPublic(partner) };
  }

  async login(email: string, password: string) {
    const e = (email || '').trim().toLowerCase();
    const partner = await this.prisma.partner.findUnique({ where: { email: e } });
    if (!partner) throw new UnauthorizedException('Неверный email или пароль');
    const ok = await bcrypt.compare(password, partner.password);
    if (!ok) throw new UnauthorizedException('Неверный email или пароль');
    if (partner.status !== 'ACTIVE') {
      throw new UnauthorizedException('Аккаунт заблокирован');
    }
    const token = await this.signFor(partner);
    return { token, partner: this.toPublic(partner) };
  }

  async me(id: string) {
    const partner = await this.prisma.partner.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException('Партнёр не найден');
    return this.toPublic(partner);
  }

  /** Скрываем password в ответах. */
  private toPublic(p: any) {
    const { password, ...rest } = p;
    return rest;
  }
}
