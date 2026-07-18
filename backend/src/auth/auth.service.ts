import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(email: string, password: string, ctx?: { ip?: string | null; userAgent?: string | null }) {
    // Нормализуем email и пароль одинаково на login и change-password,
    // чтобы случайные пробелы (copy-paste из Telegram/email) и регистр email
    // не приводили к "неверный пароль" при правильных данных.
    const normEmail = (email || '').trim().toLowerCase();
    const normPassword = (password || '').trim();

    const user = await this.prisma.user.findUnique({ where: { email: normEmail } });
    if (!user) throw new UnauthorizedException('Неверный логин или пароль');

    const ok = await bcrypt.compare(normPassword, user.password);
    if (!ok) throw new UnauthorizedException('Неверный логин или пароль');

    // Деактивированный аккаунт (уволенный сотрудник и т.п.) — даже с
    // правильным паролем в систему не пускаем.
    if (user.isActive === false) {
      throw new UnauthorizedException('Аккаунт деактивирован');
    }

    // Создаём row сессии — id сессии кладём в JWT payload как `sid`,
    // JwtStrategy будет валидировать существование + revokedAt IS NULL.
    // Это единственный способ серверно отозвать конкретный JWT без
    // ротации глобального JWT_SECRET.
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      },
      select: { id: true },
    });

    const payload = {
      sub: user.id,
      sid: session.id,
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
    // После смены пароля отзываем ВСЕ активные сессии этого юзера,
    // включая текущую — стандартное поведение, чтобы утёкший старый
    // токен не пережил ротацию пароля.
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Выход пользователя из текущей сессии. Помечает Session.revokedAt=now.
   * Следующий запрос с этим же JWT будет отклонён JwtStrategy.
   * Идемпотентно: повторный logout уже отозванной сессии — no-op.
   */
  async logout(sessionId: string) {
    if (!sessionId) return { ok: true };
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * FOUNDER принудительно отзывает сессию другого сотрудника. Используется
   * при увольнении: FOUNDER открывает список сессий уволенного и жмёт
   * «Отозвать» на каждой (либо revokeAllForUser).
   */
  async revokeSession(actor: { id: string; role?: string; roles?: string[] }, sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!session) throw new NotFoundException('Сессия не найдена');
    const isFounder = actor.role === 'FOUNDER' || (actor.roles || []).includes('FOUNDER');
    // Разрешаем: (а) FOUNDER — любую сессию; (б) владельцу — свою.
    if (!isFounder && session.userId !== actor.id) {
      throw new ForbiddenException('Недостаточно прав для отзыва этой сессии');
    }
    if (!session.revokedAt) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true };
  }

  /**
   * FOUNDER-only: отзыв всех активных сессий для указанного userId
   * (кнопка «Уволить» в UI). Не удаляет User — только гасит доступ.
   */
  async revokeAllForUser(actor: { id: string; role?: string; roles?: string[] }, targetUserId: string) {
    const isFounder = actor.role === 'FOUNDER' || (actor.roles || []).includes('FOUNDER');
    if (!isFounder && actor.id !== targetUserId) {
      throw new ForbiddenException('Только FOUNDER может отзывать чужие сессии');
    }
    const res = await this.prisma.session.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true, revoked: res.count };
  }

  /**
   * Список сессий: свои — любому авторизованному, чужие — только FOUNDER'у.
   * Возвращаем в порядке от свежих к старым.
   */
  async listSessions(actor: { id: string; role?: string; roles?: string[] }, targetUserId?: string) {
    const isFounder = actor.role === 'FOUNDER' || (actor.roles || []).includes('FOUNDER');
    const userId = targetUserId || actor.id;
    if (userId !== actor.id && !isFounder) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        revokedAt: true,
        ip: true,
        userAgent: true,
      },
    });
    return sessions;
  }
}
