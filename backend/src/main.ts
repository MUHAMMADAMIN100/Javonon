import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

async function bootstrap() {
  // rawBody: true сохраняет неизменный буфер body на req.rawBody. Нужно
  // для проверки X-Hub-Signature-256 на webhook'ах Meta (WhatsApp/IG) —
  // подпись считается от точных байтов до парсинга JSON. Без этой опции
  // переcчитанный JSON.stringify не совпадал бы с подписью Meta.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);

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
