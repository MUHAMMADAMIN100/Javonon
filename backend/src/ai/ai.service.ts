import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionCategory, TransactionType } from '@prisma/client';

/**
 * Простой парсер транзакций без внешних API:
 * "добавь расход 200$ аренда" → { type: EXPENSE, amount: 200, currency: USD, category: RENT }
 *
 * Также поддерживается опциональный Claude-API режим, если задан ANTHROPIC_API_KEY.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private config: ConfigService) {}

  async parseTransaction(text: string) {
    const trimmed = text.trim().toLowerCase();
    if (!trimmed) return null;

    // 1) Пробуем встроенный регулярник (быстро, без API).
    const local = this.parseLocally(trimmed);
    if (local) return local;

    // 2) Если есть ANTHROPIC_API_KEY — вызываем Claude, иначе возвращаем null.
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return null;
    }

    // Timeout 8 секунд — защита от висящих запросов когда Claude/сеть
    // тормозит. Без этого fetch висел до Node default (30+ сек),
    // блокируя event-loop на других обработчиках.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [
            {
              role: 'user',
              content: `Parse the following Russian sentence into a JSON transaction object. Output ONLY valid JSON, no prose.

Schema: {"type":"INCOME"|"EXPENSE","category":"TUITION_PAYMENT"|"ADDITIONAL_FEE"|"SALARY"|"RENT"|"UTILITIES"|"MARKETING"|"OFFICE"|"OTHER_INCOME"|"OTHER_EXPENSE","amount":number,"currency":"USD"|"EUR"|"CNY"|"RUB"|"TJS","comment":"string"}

Examples:
"добавь расход 200$ аренда" → {"type":"EXPENSE","category":"RENT","amount":200,"currency":"USD","comment":"аренда"}
"студент оплатил 1500$ обучение" → {"type":"INCOME","category":"TUITION_PAYMENT","amount":1500,"currency":"USD","comment":"оплата обучения"}

Sentence: "${text}"`,
            },
          ],
        }),
      });
      if (!res.ok) {
        this.logger.warn(`AI parse failed: ${res.status}`);
        return null;
      }
      const data = await res.json();
      const content = data?.content?.[0]?.text;
      if (!content) return null;
      // Извлекаем JSON
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        this.logger.warn('AI parse timeout (8s)');
      } else {
        this.logger.warn(`AI parse error: ${e?.message}`);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Локальный быстрый парсер по регуляркам (покрывает большинство кейсов). */
  private parseLocally(text: string): {
    type: TransactionType;
    category: TransactionCategory;
    amount: number;
    currency: string;
    comment: string;
  } | null {
    // Сумма
    const amountMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(\$|usd|долл|€|eur|евро|¥|cny|юан|руб|rub|сомони|tjs|сом)?/i);
    if (!amountMatch) return null;
    const amount = parseFloat(amountMatch[1].replace(',', '.'));
    const curRaw = (amountMatch[2] || '$').toLowerCase();
    let currency = 'USD';
    if (/€|eur|евро/.test(curRaw)) currency = 'EUR';
    else if (/¥|cny|юан/.test(curRaw)) currency = 'CNY';
    else if (/руб|rub/.test(curRaw)) currency = 'RUB';
    else if (/сомони|tjs|сом/.test(curRaw)) currency = 'TJS';

    // Тип
    let type: TransactionType = 'EXPENSE';
    if (/доход|оплат|приш|получ|поступ/.test(text)) type = 'INCOME';
    if (/расход|потрат|оплати[лт]|плат[еи]/.test(text)) type = 'EXPENSE';

    // Категория по ключевым словам.
    // Порядок имеет значение — более специфичные паттерны идут раньше общих.
    let category: TransactionCategory = type === 'INCOME' ? 'OTHER_INCOME' : 'OTHER_EXPENSE';
    if (/обучен|tuition|за курс|за програм/.test(text)) category = 'TUITION_PAYMENT';
    else if (/доплат/.test(text)) category = 'ADDITIONAL_FEE';
    else if (/зарплат|salary|оклад|\bзп\b/.test(text)) category = 'SALARY';
    // RENT идёт ДО OFFICE, потому что «аренда офиса» содержит оба слова
    else if (/аренд|rent/.test(text)) category = 'RENT';
    else if (/коммунал|electric|вод|свет|интернет|wifi|газ\b/.test(text)) category = 'UTILITIES';
    else if (/реклам|маркетинг|таргет|инстагр|google\s*ads|tiktok/.test(text)) category = 'MARKETING';
    else if (/канцеляр|бумаг|принтер|стол\b|стул\b|техник|компьютер|офис/.test(text)) category = 'OFFICE';

    // Комментарий — то, что осталось без цифр + чистим служебные слова-команды.
    // QA-fix #13: \b в JS regex не работает с кириллицей (\w = [A-Za-z0-9_]),
    // поэтому фильтруем по списку слов через split/filter, а не replace+regex.
    const STOP_WORDS = new Set([
      'добавь','добавить','запиши','записать','сохрани','укажи',
      'расход','расхода','доход','дохода',
      'оплата','оплате','оплаты','оплатил','оплатила','оплатили','оплати',
      'потратил','потратила','потратили','потрать',
      'поступил','поступила','поступило','поступили',
      'пришёл','пришла','пришло','пришли','пришел',
      'получил','получила','получили',
      'студент','клиент','на','за','в','с','со','по','и','ещё','please','please.',
    ]);
    const cleaned = text
      .replace(amountMatch[0], ' ')
      .replace(/[!?.,;]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOP_WORDS.has(w))
      .join(' ');
    const comment = cleaned.trim();

    return { type, category, amount, currency, comment };
  }
}
