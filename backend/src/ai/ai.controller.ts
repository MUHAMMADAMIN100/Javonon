import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AiService } from './ai.service';
import { FinanceService } from '../finance/finance.service';

@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class AiController {
  constructor(private ai: AiService, private finance: FinanceService) {}

  @Post('parse-transaction')
  parse(@Body() body: { text: string }) {
    return this.ai.parseTransaction(body.text || '');
  }

  /** Принимает текст, парсит, и сразу создаёт транзакцию. */
  @Post('add-transaction')
  async add(@Body() body: { text: string }, @CurrentUser() me: any) {
    const parsed = await this.ai.parseTransaction(body.text || '');
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
