import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { json, urlencoded } from 'express';

// Последний рубеж: НИ ОДИН незакрытый промис не имеет права уронить процесс.
//
// Node ≥15 по умолчанию (--unhandled-rejections=throw) превращает
// unhandledRejection в uncaughtException и завершает процесс, а стартуемся мы
// как голый `node dist/main` (railway.json → npm run start:prod), без
// --unhandled-rejections=warn. При restartPolicyMaxRetries: 3 детерминированный
// реджект успевает сжечь все три рестарта за минуты и оставить API лежать.
//
// Главный поставщик таких промисов — cron: cron@3 дёргает колбэки как
// `void callback.call(...)`, и @nestjs/schedule их не оборачивает. Каждый
// @Cron в CronService уже прикрыт своим try/catch (см. CronService.jobFailed),
// этот хук — страховка на будущее: новый cron, забытый .catch() у
// fire-and-forget вызова, промис в setInterval стороннего модуля. HTTP-путь
// сюда не приходит — там ошибки ловит Nest'овский exception layer.
//
// Ошибку только логируем и живём дальше: процесс, обслуживающий CRM, полезнее
// живым с одной потерянной фоновой операцией, чем мёртвым.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  new Logger('UnhandledRejection').error(err.message, err.stack);
});

async function bootstrap() {
  // bodyParser: false отключает Nest'овский авто-парсер. Мы добавим json/
  // urlencoded ниже с явными limit'ами + verify-хуком который сохраняет
  // rawBody на req.rawBody (нужно для X-Hub-Signature-256 на webhook'ах
  // Meta — подпись считается от точных байтов до парсинга).
  //
  // Прошлый коммит делал NestFactory.create({ rawBody: true }) и сверху
  // app.use(json({ limit })) — но второй парсер вешался ПОВЕРХ Nest'овского,
  // лимит фактически не применялся, а rawBody мог двусмысленно работать
  // на больших телах.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  // Trust proxy — КРИТИЧНО для rate-limiting за reverse proxy (Railway/Vercel/
  // любой L7 балансер). Без этого Express считает req.ip = IP ближайшего hop'а
  // (балансера), и throttler (см. user-throttler.guard.ts, ключ `ip:${req.ip}`)
  // сваливает ВСЕ анонимные запросы со всего интернета в один bucket:
  //   • атакующий выжигает 10/15min лимит POST /auth/login → блокирует
  //     легитимных пользователей;
  //   • распределённый brute-force вообще не тормозится, потому что per-real-IP
  //     метрики нет.
  // TRUST_PROXY можно переопределить через env (например '2' если несколько
  // hop'ов). По умолчанию '1' — Railway/Vercel/большинство PaaS дают ровно
  // один прокси-хоп перед приложением. Значение парсится Express'ом:
  // число = сколько hop'ов доверять, строка = список подсетей, 'true'/'false' =
  // trust all / none.
  const trustProxyRaw = config.get<string>('TRUST_PROXY') ?? '1';
  const trustProxy: number | string | boolean = (() => {
    if (trustProxyRaw === 'true') return true;
    if (trustProxyRaw === 'false') return false;
    const n = Number(trustProxyRaw);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : trustProxyRaw;
  })();
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);

  // 1MB — generous для plain-JSON (auth payloads ≤ 1KB, DTOs <10KB,
  // student-form-update теперь capped at 100KB). Multer-uploads идут
  // отдельным multipart-парсером со своими per-route limits и не задеты.
  // verify-хук кладёт исходный буфер на req.rawBody — этим пользуются
  // TwilioSignatureGuard и MetaSignatureGuard.
  app.use(
    json({
      limit: '1mb',
      verify: (req: any, _res, buf) => { req.rawBody = buf; },
    }),
  );
  app.use(urlencoded({ limit: '1mb', extended: true }));

  // Security headers (helmet) — CSP, X-Frame-Options, X-Content-Type-Options,
  // HSTS и т.д. CSP отключаем потому что у нас REST + WebSocket API,
  // нет inline-скриптов в response; CSP на фронте задаётся CDN-уровнем
  // (Vercel) или статикой. Остальные default-настройки безопасны для API.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // SIGTERM от Railway/Docker → onModuleDestroy → prisma.$disconnect().
  // Без этого каждый редеплой оставляет в Postgres «висящие» TCP-соединения,
  // которые попадают в логи как «SSL error: unexpected eof while reading» /
  // «Connection reset by peer» и постепенно съедают max_connections.
  app.enableShutdownHooks();

  const corsOrigins = (config.get<string>('CORS_ORIGINS') || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Всегда разрешаем основные домены проекта (даже если их забыли в env).
  // Wildcard *.javonon.com и *.vercel.app поддерживаются ниже.
  const ALWAYS_ALLOWED_HOSTS = [
    'javonon.com',
    'www.javonon.com',
    'javonon-crm.vercel.app',
    'javonon-landing.vercel.app',
    'javonon.vercel.app',
    'localhost:5173',
    'localhost:5174',
  ];

  const checkOrigin = (origin: string | undefined, cb: (err: any, ok?: boolean) => void) => {
    if (!origin) return cb(null, true); // запросы без Origin (curl, server-to-server)
    try {
      const url = new URL(origin);
      const host = url.host;
      // Точные совпадения из env
      if (corsOrigins.some((o) => o === origin || o === `${url.protocol}//${host}` || o === host)) {
        return cb(null, true);
      }
      // Хардкод: основные домены проекта
      if (ALWAYS_ALLOWED_HOSTS.includes(host)) return cb(null, true);
      // Wildcard *.javonon.com и *.vercel.app
      if (host.endsWith('.javonon.com') || host.endsWith('.vercel.app')) {
        return cb(null, true);
      }
      // Security fix: НЕ разрешаем все origins если CORS_ORIGINS пуст.
      // Раньше return cb(null, true) — это позволяло любому стороннему
      // сайту делать запросы с credentials, что открыло бы CSRF.
      // Теперь fallback: разрешать только если localhost (dev режим).
      if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
        return cb(null, true);
      }
      return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    } catch {
      return cb(new Error('Bad Origin'), false);
    }
  };

  app.enableCors({
    origin: checkOrigin,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.setGlobalPrefix('api');

  const port = parseInt(config.get<string>('PORT') || '3001', 10);
  await app.listen(port);
  console.log(`🚀 Javonon API: http://localhost:${port}/api`);
}
bootstrap();
