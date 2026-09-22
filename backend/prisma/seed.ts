/**
 * Базовый сидер: первый основатель (только в пустой базе) + (опционально)
 * демо-заявки.
 *
 * `start:prod` запускает этот скрипт при КАЖДОМ деплое, поэтому он:
 *  - НЕ трогает существующие учётки (раньше upsert каждый раз ставил
 *    founder@javonon.local роль FOUNDER, а admin@javonon.local существовал
 *    с зашитым паролем admin123);
 *  - создаёт основателя, только если в базе нет ни одного FOUNDER, и только
 *    с паролем из FOUNDER_PASSWORD (не короче 12 символов) — пароля по
 *    умолчанию нет;
 *  - не создаёт демо-админа;
 *  - не печатает пароли в лог.
 *
 * Демо-заявки — за флагом SEED_DEMO_APPLICATIONS=1: прод демо-данные
 * получать не должен.
 */
import { PrismaClient, Role, Direction, ApplicationStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SEED_DEMO_APPLICATIONS = process.env.SEED_DEMO_APPLICATIONS === '1';

async function main() {
  console.log('🌱 Seeding database...');

  const founders = await prisma.user.count({
    where: { OR: [{ role: Role.FOUNDER }, { roles: { has: Role.FOUNDER } }] },
  });
  if (founders > 0) {
    console.log('   Основатель уже есть — учётки не трогаем.');
  } else {
    const email = (process.env.FOUNDER_EMAIL || 'founder@javonon.local').trim().toLowerCase();
    const raw = (process.env.FOUNDER_PASSWORD || '').trim();
    if (raw.length < 12) {
      console.log('   Основателя нет: задайте FOUNDER_PASSWORD (не короче 12 символов) и перезапустите — пароля по умолчанию нет.');
    } else {
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) {
        console.log(`   ${email} уже существует — роль не меняем, основателя назначьте вручную.`);
      } else {
        await prisma.user.create({
          data: {
            email,
            password: await bcrypt.hash(raw, 10),
            fullName: 'Основатель',
            role: Role.FOUNDER,
            roles: [Role.FOUNDER],
          },
        });
        console.log(`   Создан основатель ${email} (пароль — из FOUNDER_PASSWORD).`);
      }
    }
  }

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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
