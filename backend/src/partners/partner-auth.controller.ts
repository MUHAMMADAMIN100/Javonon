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

@Controller('partner-auth')
export class PartnerAuthController {
  constructor(private svc: PartnerAuthService) {}

  /** Регистрация партнёра — публичный эндпоинт, защищён throttle. */
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(
    @Body() body: {
      email: string;
      password: string;
      fullName: string;
      phone?: string;
    },
  ) {
    return this.svc.register(body);
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() body: { email: string; password: string }) {
    return this.svc.login(body.email, body.password);
  }

  @Get('me')
  @UseGuards(PartnerJwtGuard)
  me(@Req() req: any) {
    return this.svc.me(req.user.id);
  }
}
