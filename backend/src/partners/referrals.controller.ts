import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { resolveLandingBaseUrl } from '../common/landing-url';
import { ReferralsService } from './referrals.service';

/**
 * Публичные эндпоинты реферальной системы:
 *  - GET /r/:code — редирект на лендинг или Telegram-бот с записью клика
 *  - POST /referrals/click — frontend-инициированный клик (когда лендинг
 *    видит ?ref= в URL первого визита)
 *  - GET /referrals/resolve/:code — проверить что код валиден (для UI)
 */
@Controller()
export class ReferralsController {
  // Если задано — короткие /r/:code редиректят сразу в Telegram-бот.
  // Иначе — на главный лендинг с query ?ref=CODE.
  private botUsername = process.env.TELEGRAM_BOT_USERNAME || '';

  constructor(private svc: ReferralsService) {}

  /**
   * URL лендинга для редиректов из /r/:code.
   *
   * Base — общий resolveLandingBaseUrl (см. common/landing-url.ts): раньше тут
   * было своё `process.env.LANDING_URL || ...`, и его дефолт расходился с
   * partners.service.ts.
   *
   * Всегда добавляем #apply: человек, кликнувший партнёрскую короткую ссылку,
   * пришёл подавать заявку, а не читать шапку — везём его сразу к форме.
   * Порядок частей жёсткий — query, потом фрагмент: всё после '#' браузер в
   * query-string уже не отдаёт, и ?ref= бы потерялся.
   */
  private landingApplyUrl(query?: Record<string, string>): string {
    const base = resolveLandingBaseUrl();
    const entries = Object.entries(query || {});
    if (entries.length === 0) return `${base}/#apply`;

    // LANDING_URL может нести собственные параметры (например ...?utm_source=x) —
    // не затираем их, дописываемся через '&'.
    const sep = base.includes('?') ? '&' : '/?';
    const qs = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return `${base}${sep}${qs}#apply`;
  }

  /** Короткая публичная ссылка партнёра: site/r/ABC123 */
  @Get('r/:code')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async shortRedirect(
    @Param('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const partner = await this.svc.findPartnerByCode(code);
    // Логируем клик независимо от валидности (фрод-аналитика)
    await this.svc.registerClick({
      code,
      source: 'SITE',
      ip: (req.headers['x-forwarded-for'] as string) || req.ip,
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer'],
    });

    if (!partner) {
      return res.redirect(this.landingApplyUrl());
    }

    // Если есть Telegram-бот — отправляем туда (центр воронки).
    if (this.botUsername) {
      return res.redirect(
        `https://t.me/${this.botUsername}?start=${partner.referralCode}`,
      );
    }
    // Иначе на лендинг с ?ref= и якорем на форму заявки.
    return res.redirect(this.landingApplyUrl({ ref: partner.referralCode }));
  }

  /** Фронтенд логирует переход (используется когда юзер пришёл по ?ref=). */
  @Post('referrals/click')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async clickFromFront(
    @Body() body: { code: string; source?: 'SITE' | 'BOT' },
    @Req() req: Request,
  ) {
    await this.svc.registerClick({
      code: body.code,
      source: body.source || 'SITE',
      ip: (req.headers['x-forwarded-for'] as string) || req.ip,
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer'],
    });
    return { ok: true };
  }

  /** Проверка ref-кода — для UI чтобы показать имя партнёра ("вас пригласил X"). */
  @Get('referrals/resolve')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async resolve(@Query('code') code: string) {
    const p = await this.svc.findPartnerByCode(code);
    if (!p) return { ok: false };
    return { ok: true, partner: { fullName: p.fullName, code: p.referralCode } };
  }
}
