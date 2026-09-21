/**
 * ТЕСТОВЫЕ ДАННЫЕ для проверки поиска на экране /leads.
 *
 * 30 лидов NEW_LEAD (две страницы по 25) с именами кириллицей и латиницей,
 * номерами в разном написании (слитно, с пробелами, с дефисами), отдельным
 * WhatsApp у части из них, плюс один лид в статусе «в работе» — поиск по
 * экрану лидов его находить НЕ должен. Перезапуск приводит данные в
 * исходное состояние.
 *
 * РАБОТАЕТ ТОЛЬКО С ЛОКАЛЬНОЙ ТЕСТОВОЙ БАЗОЙ javonon_e2e — на любой другой
 * DATABASE_URL скрипт отказывается стартовать, потому что удаляет строки.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5455/javonon_e2e \
 *     npx ts-node -T scripts/e2e-leads-search-fixtures.ts
 */
import 'dotenv/config';
import { ApplicationStatus, Country, Direction, PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const url = process.env.DATABASE_URL || '';
if (!/@127\.0\.0\.1:\d+\/javonon_e2e$/.test(url)) {
  console.error('ОТКАЗ: фикстуры пишутся только в локальную javonon_e2e.');
  process.exit(1);
}

const prisma = new PrismaClient();

const MARK = 'Поиск-тест'; // в комментарии — по нему чистим прошлый прогон

async function main() {
  const password = await bcrypt.hash('test12345', 10);
  const mgr = await prisma.user.upsert({
    where: { email: 'search.mgr@e2e.local' },
    update: { fullName: 'Поиск Менеджер', isActive: true },
    create: {
      email: 'search.mgr@e2e.local',
      fullName: 'Поиск Менеджер',
      role: Role.SALES_MANAGER,
      roles: [Role.SALES_MANAGER],
      password,
    },
  });

  await prisma.application.deleteMany({ where: { comment: MARK } });

  const named: Array<{
    fullName: string;
    phone: string;
    whatsappPhone?: string;
    country?: Country;
    managerId?: string;
    status?: ApplicationStatus;
  }> = [
    { fullName: 'Qodirov Muhammadsharif', phone: '+992918999916', country: Country.CHINA },
    { fullName: 'Илёсов Муҳаммадалӣ Муқтадимович', phone: '+992 007 44 34 61', country: Country.USA },
    { fullName: 'Davlatova Guliston', phone: '+992-204-04-38-83', whatsappPhone: '+992555123456', country: Country.USA, managerId: mgr.id },
    { fullName: 'Сафаров Хуршед', phone: '+992026593535' },
    { fullName: 'Али Валиев', phone: '+992 90 111 22 33', whatsappPhone: '+79161234567' },
    // Не лид (уже в работе): поиск на экране лидов его не показывает.
    { fullName: 'Qodirov В Работе', phone: '+992918999900', status: ApplicationStatus.IN_PROCESSING },
  ];
  const base = Date.now();
  let i = 0;
  for (const n of named) {
    i += 1;
    await prisma.application.create({
      data: {
        fullName: n.fullName,
        phone: n.phone,
        whatsappPhone: n.whatsappPhone ?? n.phone,
        country: n.country ?? null,
        managerId: n.managerId ?? null,
        status: n.status ?? ApplicationStatus.NEW_LEAD,
        direction: Direction.BACHELOR,
        comment: MARK,
        createdAt: new Date(base - i * 60_000),
      },
    });
  }
  // Наполнитель — чтобы у списка было две страницы.
  for (let k = 1; k <= 25; k++) {
    await prisma.application.create({
      data: {
        fullName: `Filler Lead ${String(k).padStart(2, '0')}`,
        phone: `+99270000${String(k).padStart(4, '0')}`,
        status: ApplicationStatus.NEW_LEAD,
        direction: Direction.BACHELOR,
        comment: MARK,
        createdAt: new Date(base - (100 + k) * 60_000),
      },
    });
  }
  console.log('OK: лиды для проверки поиска созданы');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
