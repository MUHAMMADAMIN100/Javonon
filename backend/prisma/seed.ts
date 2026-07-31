/**
 * Базовый сидер: учётки FOUNDER/ADMIN + (опционально) демо-заявки.
 *
 * Учётки сидятся ВСЕГДА — это upsert по email, он идемпотентен и нужен,
 * чтобы на новом окружении было кем залогиниться.
 *
 * Демо-заявки — за флагом SEED_DEMO_APPLICATIONS=1. Почему за флагом:
 * `start:prod` дёргает этот скрипт на КАЖДОМ старте прода, а единственной
 * защитой был `findFirst({ phone })`. Стоило удалить/отредактировать демо-строки
 * (или поднять чистое окружение) — и прод снова получал три фейковых лида
 * в общий список заявок. Прод демо-данные получать не должен.
 */
import { PrismaClient, Role, Direction, ApplicationStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Демо-заявки создаём только по явному запросу (локальная разработка,
 * демо-стенд). `start:prod` этот флаг не выставляет — см. package.json.
 */
const SEED_DEMO_APPLICATIONS = process.env.SEED_DEMO_APPLICATIONS === '1';

async function main() {
  console.log('🌱 Seeding database...');

  // FOUNDER — единственный, кто раздаёт роли. Если пароль не задан через env,
  // используем дефолтный (нужно сменить через /me).
  const founderEmail = 'founder@javonon.local';
  const founderPassword = await bcrypt.hash(
    process.env.FOUNDER_PASSWORD || 'founder123',
    10,
  );
  await prisma.user.upsert({
    where: { email: founderEmail },
    update: { role: Role.FOUNDER },
    create: {
      email: founderEmail,
      password: founderPassword,
      fullName: 'Основатель Javonon',
      role: Role.FOUNDER,
      roles: [Role.FOUNDER],
    },
  });

  // ADMIN — legacy seed для совместимости со старыми инструкциями.
  const adminEmail = 'admin@javonon.local';
  const adminPassword = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      password: adminPassword,
      fullName: 'Главный администратор',
      role: Role.ADMIN,
      roles: [Role.ADMIN],
    },
  });

  // Несколько демо-заявок (международные направления).
  //
  // Статусы — ТОЛЬКО из актуального набора квалификации лида. Легаси-значения
  // (NEW, IN_PROGRESS, DOCS_REVIEW, …) писать нельзя: этот скрипт в `start:prod`
  // выполняется ПОСЛЕ prisma/migrate-lead-statuses.ts, то есть созданная здесь
  // легаси-строка переносом уже не подхватится. И «на следующем деплое
  // подхватится» тоже не сработает: перенос запускается только по явному
  // MIGRATE_LEAD_STATUSES (см. src/common/application-status.ts), а после
  // раскатки флаг снимают. Такая строка не показывается ни в одном фильтре CRM
  // и держит ссылку на легаси-значение enum'а, блокируя его будущую уборку.
  const demoApps = [
    {
      fullName: 'Иванов Алексей Петрович',
      phone: '+992 900 123 456',
      email: 'alex@example.com',
      direction: Direction.BACHELOR,
      comment: 'Интересует грант на бакалавриат в США.',
      status: ApplicationStatus.NEW_LEAD,
    },
    {
      fullName: 'Каримова Малика',
      phone: '+992 901 222 333',
      direction: Direction.LANGUAGE,
      comment: 'Хочу пройти языковую программу в Германии.',
      // Исторически здесь были IN_PROGRESS, затем DOCS_REVIEW — оба легаси.
      // Актуальный эквивалент по маппингу migrate-lead-statuses.ts — IN_PROCESSING.
      status: ApplicationStatus.IN_PROCESSING,
    },
    {
      fullName: 'Раджабов Фаррух',
      phone: '+992 555 777 888',
      email: 'farr@example.com',
      direction: Direction.MASTER,
      comment: 'Магистратура в Южной Корее, IT-направление.',
      status: ApplicationStatus.NEW_LEAD,
    },
  ];

  if (SEED_DEMO_APPLICATIONS) {
    for (const a of demoApps) {
      const exists = await prisma.application.findFirst({ where: { phone: a.phone } });
      if (!exists) {
        await prisma.application.create({ data: a });
      }
    }
    console.log(`   Демо-заявки: ${demoApps.length} шт. (SEED_DEMO_APPLICATIONS=1)`);
  } else {
    console.log('   Демо-заявки пропущены (задай SEED_DEMO_APPLICATIONS=1, чтобы создать).');
  }

  console.log('✅ Seed complete.');
  console.log(`   Founder: ${founderEmail} / ${process.env.FOUNDER_PASSWORD || 'founder123'} (change in /me)`);
  console.log(`   Admin:   ${adminEmail} / admin123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
