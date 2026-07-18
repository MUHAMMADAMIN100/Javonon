import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';

// Извлекаем реальный IP клиента: за Railway/nginx-прокси он приезжает в
// X-Forwarded-For (первый элемент до запятой). Без прокси — req.ip.
// Только для аудит-лога сессии, безопасность не зависит от точности.
function extractIp(req: Request): string | null {
  const xff = (req.headers['x-forwarded-for'] as string | undefined) || '';
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || null;
}

function extractUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  if (!ua) return null;
  const s = Array.isArray(ua) ? ua[0] : ua;
  // Обрезаем для защиты от бесконечных строк из левых клиентов.
  return s.length > 500 ? s.slice(0, 500) : s;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // Brute-force защита. Глобальный throttle 60/min не подходит для login —
  // 60 попыток пароля в минуту = 86k в день с одного IP, любой короткий
  // пароль перебрать. 10 попыток / 15 минут на IP+UA — стандарт OWASP.
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, {
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { sub: string }) {
    return this.auth.me(user.sub);
  }

  // Выход из текущей сессии: отзываем ту, чей sid лежит в JWT. После этого
  // тот же bearer-токен перестаёт проходить JwtStrategy.validate.
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  logout(@CurrentUser() user: { sub: string; sid?: string }) {
    return this.auth.logout(user.sid || '');
  }

  // Свои сессии видит любой авторизованный; чужие — только FOUNDER
  // (проверка в auth.service.listSessions).
  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  listOwnSessions(@CurrentUser() user: { id: string; sub: string; role?: string; roles?: string[] }) {
    return this.auth.listSessions({ id: user.id ?? user.sub, role: user.role, roles: user.roles });
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions/user/:userId')
  listUserSessions(
    @CurrentUser() user: { id: string; sub: string; role?: string; roles?: string[] },
    @Param('userId') userId: string,
  ) {
    return this.auth.listSessions(
      { id: user.id ?? user.sub, role: user.role, roles: user.roles },
      userId,
    );
  }

  // FOUNDER (или владелец) отзывает конкретную сессию. Используется в UI
  // «Активные устройства» и в форме увольнения.
  @UseGuards(JwtAuthGuard)
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  revokeSession(
    @CurrentUser() user: { id: string; sub: string; role?: string; roles?: string[] },
    @Param('id') id: string,
  ) {
    return this.auth.revokeSession(
      { id: user.id ?? user.sub, role: user.role, roles: user.roles },
      id,
    );
  }

  // FOUNDER-only: разом отозвать все живые сессии сотрудника. Именно эта
  // ручка должна дёргаться из UI «уволить». Без неё уволенный сотрудник
  // оставался авторизованным до истечения JWT (до 30 дней).
  @UseGuards(JwtAuthGuard)
  @Post('sessions/user/:userId/revoke-all')
  @HttpCode(200)
  revokeAllForUser(
    @CurrentUser() user: { id: string; sub: string; role?: string; roles?: string[] },
    @Param('userId') userId: string,
  ) {
    return this.auth.revokeAllForUser(
      { id: user.id ?? user.sub, role: user.role, roles: user.roles },
      userId,
    );
  }

  // Throttle: 5 попыток на 15 мин. Без него атакующий, получивший JWT
  // (через XSS / shoulder-surfing), мог brute-force'ить currentPassword
  // на global 60/min — 86k попыток/день. Тот же OWASP-стандарт что
  // login.
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(
    @CurrentUser() user: { sub: string },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.sub, dto.currentPassword, dto.newPassword);
  }
}
