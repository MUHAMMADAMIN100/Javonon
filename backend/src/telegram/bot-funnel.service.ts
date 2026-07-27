import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Markup, Context } from 'telegraf';
import { PrismaService } from '../prisma/prisma.service';
import { ReferralsService } from '../partners/referrals.service';
import { resolveLandingBaseUrl } from '../common/landing-url';

/**
 * Telegram-бот как центр воронки.
 *
 * Логика:
 *  - /start [ref_code]:
 *      • создаём/обновляем BotSession (telegramUserId + partnerCode)
 *      • регистрируем атрибуцию (партнёру засчитываем "лид")
 *      • показываем приветствие + меню
 *  - Меню (inline-кнопки):
 *      📊 Что внутри  → пояснение продукта
 *      💰 Как заработать  → партнёрская программа
 *      📈 Кейсы  → социальные доказательства
 *      🚀 Купить  → ссылка на оплату / лендинг
 *  - При оплате (callback от платёжной системы / админ маркает) →
 *    отправляем инвайт в закрытый канал, начисляем партнёру.
 *
 * Подключается через long-polling (Telegraf launch). Не блокирует
 * startup: запуск через .launch() в фоне, ошибки логируются и не валят
 * приложение.
 */
@Injectable()
export class BotFunnelService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(BotFunnelService.name);
  private bot: Telegraf | null = null;
  private launched = false;

  // Конфиг текстов — можно вынести в БД позже, пока в коде для простоты.
  private readonly MESSAGES = {
    welcome: (firstName?: string) =>
      `👋 Привет${firstName ? `, ${firstName}` : ''}!\n\n` +
      `Это *Javonon* — система, которая помогает поступить в зарубежные вузы по гранту 🎓\n\n` +
      `Жми кнопку ниже и выбери что интересно 👇`,
    whatInside:
      `📊 *Что внутри Javonon*\n\n` +
      `• Подбор грантов под твой профиль\n` +
      `• Прокачка кандидатуры (CV, мотивационное письмо)\n` +
      `• Подача заявки в университеты\n` +
      `• Полное сопровождение до зачисления\n\n` +
      `Готов начать? Нажми "🚀 Купить"`,
    howToEarn: (refLink?: string) =>
      `💰 *Партнёрская программа*\n\n` +
      `Зарабатывай комиссию приводя клиентов:\n` +
      `• Регистрируешься на сайте\n` +
      `• Получаешь уникальную ссылку\n` +
      `• Льёшь трафик с TikTok/Instagram\n` +
      `• С каждой оплаты получаешь свой %\n\n` +
      (refLink
        ? `Зарегистрироваться: ${refLink}`
        : `Зарегистрируйся на сайте и забери свою реферальную ссылку.`),
    cases:
      `📈 *Кейсы наших студентов*\n\n` +
      `🇨🇳 Tsinghua — 8 студентов в 2024\n` +
      `🇰🇷 KAIST — 5 студентов\n` +
      `🇩🇪 TU Munich — 3 студента\n` +
      `🇺🇸 Harvard — 1 студент\n\n` +
      `Все на полной стипендии. Готов быть следующим?`,
    buy: (buyUrl: string) =>
      `🚀 *Запиши на консультацию*\n\n` +
      `Жми кнопку ниже чтобы перейти на сайт. Оплата за консультацию + сопровождение.\n\n` +
      `[Перейти к оплате](${buyUrl})`,
  };

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private referrals: ReferralsService,
  ) {}

  private mainMenu() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 Что внутри', 'menu:what'),
        Markup.button.callback('💰 Как заработать', 'menu:earn'),
      ],
      [
        Markup.button.callback('📈 Кейсы', 'menu:cases'),
        Markup.button.callback('🚀 Купить', 'menu:buy'),
      ],
    ]);
  }

  async onApplicationBootstrap() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const enableFunnel = this.config.get<string>('TELEGRAM_FUNNEL_ENABLED') !== '0';
    if (!token || !enableFunnel) {
      this.log.warn(
        'Funnel-бот выключен (TELEGRAM_BOT_TOKEN отсутствует или TELEGRAM_FUNNEL_ENABLED=0)',
      );
      return;
    }
    this.bot = new Telegraf(token);
    this.wireHandlers();
    // Launch в фоне — не блокируем startup приложения.
    this.bot
      .launch({ dropPendingUpdates: true })
      .then(() => {
        this.launched = true;
        this.log.log('Telegram funnel bot launched (long-polling)');
      })
      .catch((e) => this.log.error('Funnel bot launch failed', e));
  }

  async onModuleDestroy() {
    if (this.bot && this.launched) {
      try { this.bot.stop('SIGTERM'); } catch {}
    }
  }

  private wireHandlers() {
    if (!this.bot) return;

    this.bot.start(async (ctx) => {
      try {
        const arg = (ctx.message as any)?.text?.split(' ')[1]?.trim();
        const tgUser = ctx.from;
        if (!tgUser) return;

        // Сохраняем сессию бота. Если есть ref-код — записываем партнёра.
        const existing = await this.prisma.botSession.findUnique({
          where: { telegramUserId: String(tgUser.id) },
        });
        if (existing) {
          // Не перезаписываем partnerCode если уже был — первая атрибуция
          // приоритетнее (защита от "перепривязки" через повторный /start).
          if (!existing.partnerCode && arg) {
            await this.prisma.botSession.update({
              where: { id: existing.id },
              data: { partnerCode: arg.toUpperCase() },
            });
          }
        } else {
          await this.prisma.botSession.create({
            data: {
              telegramUserId: String(tgUser.id),
              telegramUsername: tgUser.username,
              firstName: tgUser.first_name,
              lastName: tgUser.last_name,
              partnerCode: arg ? arg.toUpperCase() : null,
              funnelStep: 1,
            },
          });
        }

        // Атрибуция в реферальной системе
        if (arg) {
          this.referrals
            .attribute({
              code: arg.toUpperCase(),
              source: 'BOT',
              telegramUserId: String(tgUser.id),
            })
            .catch(() => undefined);
        }

        await ctx.replyWithMarkdown(
          this.MESSAGES.welcome(tgUser.first_name),
          this.mainMenu() as any,
        );
      } catch (e) {
        this.log.error('start handler failed', e as Error);
      }
    });

    this.bot.action('menu:what', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(this.MESSAGES.whatInside, this.mainMenu() as any);
      } catch {}
    });

    this.bot.action('menu:earn', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        // Без #apply: это ссылка на регистрацию ПАРТНЁРА (/partner/register),
        // отдельная страница-роут, а не форма заявки студента на лендинге.
        const landing = resolveLandingBaseUrl((k) => this.config.get<string>(k));
        await ctx.replyWithMarkdown(
          this.MESSAGES.howToEarn(`${landing}/partner/register`),
          this.mainMenu() as any,
        );
      } catch {}
    });

    this.bot.action('menu:cases', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(this.MESSAGES.cases, this.mainMenu() as any);
      } catch {}
    });

    this.bot.action('menu:buy', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        // Передаём ref в URL чтобы атрибуция продолжилась на сайте.
        const session = await this.prisma.botSession.findUnique({
          where: { telegramUserId: String(ctx.from!.id) },
        });
        // Здесь #apply уместен и уже был: кнопка «Купить» ведёт человека
        // прямо на форму заявки. Приводим к тому же формату, что и
        // partners.service.buildReferralUrl — '/?ref=CODE#apply'.
        const landing = resolveLandingBaseUrl((k) => this.config.get<string>(k));
        const ref = session?.partnerCode;
        const url = ref ? `${landing}/?ref=${ref}#apply` : `${landing}/#apply`;
        await ctx.replyWithMarkdown(this.MESSAGES.buy(url));
      } catch {}
    });

    // Любое сообщение пользователя — возвращаем меню (защита от потерянных).
    this.bot.on('message', async (ctx) => {
      try {
        if ((ctx.message as any)?.text?.startsWith('/')) return;
        await ctx.reply('Выбери действие 👇', this.mainMenu() as any);
      } catch {}
    });
  }
}
