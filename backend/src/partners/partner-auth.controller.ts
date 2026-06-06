import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PartnerAuthService } from './partner-auth.service';
import { PartnerJwtGuard } from './partner-jwt.guard';
import { PartnerLoginDto, PartnerRegisterDto } from './dto/partner-auth.dto';

@Controller('partner-auth')
export class PartnerAuthController {
  constructor(private svc: PartnerAuthService) {}

  /** Регистрация партнёра — публичный эндпоинт, защищён throttle + DTO. */
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() body: PartnerRegisterDto) {
    return this.svc.register(body);
  }

  // OWASP login throttle 10/15min — раньше 10/min было слишком слабо
  // против перебора паролей коротких партнёров.
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  login(@Body() body: PartnerLoginDto) {
    return this.svc.login(body.email, body.password);
  }

  @Get('me')
  @UseGuards(PartnerJwtGuard)
  me(@Req() req: any) {
    return this.svc.me(req.user.id);
  }
}
