import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // Brute-force защита. Глобальный throttle 60/min не подходит для login —
  // 60 попыток пароля в минуту = 86k в день с одного IP, любой короткий
  // пароль перебрать. 10 попыток / 15 минут на IP+UA — стандарт OWASP.
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { sub: string }) {
    return this.auth.me(user.sub);
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
