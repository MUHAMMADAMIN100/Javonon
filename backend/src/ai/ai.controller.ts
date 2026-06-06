import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AiService } from './ai.service';
import { FinanceService } from '../finance/finance.service';

// Максимум 500 символов на запрос к Claude. Реальные транзакционные
// фразы укладываются в ~150 ("добавь расход 200$ аренда офиса август"),
// 500 — безопасный буфер. Без cap'а compromised admin или
// accidental-paste мог слать 100k символов = $$$ на Anthropic billing.
const AI_MAX_TEXT = 500;

function validateAiText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new BadRequestException('text должен быть строкой');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new BadRequestException('text не может быть пустым');
  }
  if (trimmed.length > AI_MAX_TEXT) {
    throw new BadRequestException(`Слишком длинный текст (макс. ${AI_MAX_TEXT} символов)`);
  }
  return trimmed;
}

@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
// 10 AI запросов в минуту на IP. Каждый запрос — потенциальный hit на
// Claude API. Глобал 60/min даёт >> $$$/день при злоупотреблении.
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AiController {
  constructor(private ai: AiService, private finance: FinanceService) {}

  @Post('parse-transaction')
  parse(@Body() body: { text: string }) {
    const text = validateAiText(body?.text);
    return this.ai.parseTransaction(text);
  }

  /** Принимает текст, парсит, и сразу создаёт транзакцию. */
  @Post('add-transaction')
  async add(@Body() body: { text: string }, @CurrentUser() me: any) {
    const text = validateAiText(body?.text);
    const parsed = await this.ai.parseTransaction(text);
    if (!parsed) {
      return { ok: false, error: 'Не удалось распознать. Попробуйте: "добавь расход 200$ аренда"' };
    }
    const transaction = await this.finance.create(
      {
        type: parsed.type,
        category: parsed.category,
        amount: parsed.amount,
        currency: parsed.currency,
        comment: parsed.comment,
      },
      me.id,
    );
    return { ok: true, parsed, transaction };
  }
}
