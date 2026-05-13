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
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Некорректный email');
    }
    // Триммируем пароль ОДИН раз — далее везде используем normalized.
    // Без этого "  abc123  " проходило валидацию (len=9), сохранялось
    // через bcrypt с пробелами, а login(abc123) падал т.к. compare false.
    const password = (input.password || '').trim();
    if (!password || password.length < 6) {
      throw new BadRequestException('Пароль минимум 6 символов');
    }
    if (password.length > 100) {
      throw new BadRequestException('Пароль слишком длинный');
    }
    const fullName = (input.fullName || '').trim();
    if (!fullName || fullName.length < 2) {
      throw new BadRequestException('Укажи имя');
    }
    if (fullName.length > 120) {
      throw new BadRequestException('Имя слишком длинное');
    }
    const exists = await this.prisma.partner.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email уже зарегистрирован');

    const passwordHash = await bcrypt.hash(password, 10);
    const referralCode = await this.uniqueCode();

    let partner;
    try {
      partner = await this.prisma.partner.create({
        data: {
          email,
          password: passwordHash,
          fullName,
          phone: input.phone?.trim() || null,
          referralCode,
        },
      });
    } catch (e: any) {
      // Race: два параллельных register с одним email
      if (e?.code === 'P2002') {
        throw new ConflictException('Email уже зарегистрирован');
      }
      throw e;
    }

    const token = await this.signFor(partner);
    return { token, partner: this.toPublic(partner) };
  }

  async login(email: string, password: string) {
    const e = (email || '').trim().toLowerCase();
    // Триммируем пароль — симметрично с register.
    const p = (password || '').trim();
    if (!e || !p) {
      throw new UnauthorizedException('Неверный email или пароль');
    }
    const partner = await this.prisma.partner.findUnique({ where: { email: e } });
    if (!partner) throw new UnauthorizedException('Неверный email или пароль');
    const ok = await bcrypt.compare(p, partner.password);
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
