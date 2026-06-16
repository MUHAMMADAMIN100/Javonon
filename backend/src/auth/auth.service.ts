import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    // Нормализуем email и пароль одинаково на login и change-password,
    // чтобы случайные пробелы (copy-paste из Telegram/email) и регистр email
    // не приводили к "неверный пароль" при правильных данных.
    const normEmail = (email || '').trim().toLowerCase();
    const normPassword = (password || '').trim();

    const user = await this.prisma.user.findUnique({ where: { email: normEmail } });
    if (!user) throw new UnauthorizedException('Неверный логин или пароль');

    const ok = await bcrypt.compare(normPassword, user.password);
    if (!ok) throw new UnauthorizedException('Неверный логин или пароль');

    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      roles: user.roles || [],
    };
    const token = await this.jwt.signAsync(payload);

    // Подтянем CustomRole для login response, чтобы UI сразу знал
    // permissions без второго запроса.
    const fullUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        customRoleId: true,
        customRole: { select: { id: true, name: true, isActive: true, permissions: true } },
      },
    });
    const perms = fullUser?.customRole?.isActive ? (fullUser.customRole.permissions || []) : [];

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        roles: user.roles || [],
        customRoleId: fullUser?.customRoleId || null,
        customRole: fullUser?.customRole || null,
        permissions: perms,
      },
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, fullName: true, role: true, roles: true,
        customRoleId: true,
        customRole: { select: { id: true, name: true, isActive: true, permissions: true } },
      },
    });
    if (!user) throw new UnauthorizedException();
    const perms = user.customRole?.isActive ? (user.customRole.permissions || []) : [];
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      roles: user.roles || [],
      customRoleId: user.customRoleId || null,
      customRole: user.customRole || null,
      permissions: perms,
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    // Применяем ту же нормализацию, что и в login() — иначе хэш сохранится с
    // пробелами, а при логине без пробелов сравнение провалится.
    const normCurrent = (currentPassword || '').trim();
    const normNew = (newPassword || '').trim();

    if (!normNew || normNew.length < 8) {
      throw new BadRequestException('Новый пароль: минимум 8 символов');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const ok = await bcrypt.compare(normCurrent, user.password);
    if (!ok) throw new UnauthorizedException('Текущий пароль неверный');

    const hashed = await bcrypt.hash(normNew, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    return { ok: true };
  }
}
