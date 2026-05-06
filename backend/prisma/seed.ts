import { PrismaClient, Role, Direction, ApplicationStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  const adminEmail = 'admin@javonon.local';
  const employeeEmail = 'employee@javonon.local';

  const adminPassword = await bcrypt.hash('admin123', 10);
  const employeePassword = await bcrypt.hash('employee123', 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      password: adminPassword,
      fullName: 'Главный администратор',
      role: Role.ADMIN,
    },
  });

  await prisma.user.upsert({
    where: { email: employeeEmail },
    update: {},
    create: {
      email: employeeEmail,
      password: employeePassword,
      fullName: 'Айгуль Сотрудник',
      role: Role.EMPLOYEE,
    },
  });

  // Несколько демо-заявок (международные направления)
  const demoApps = [
    {
      fullName: 'Иванов Алексей Петрович',
      phone: '+992 900 123 456',
      email: 'alex@example.com',
      direction: Direction.BACHELOR,
      comment: 'Интересует грант на бакалавриат в США.',
      status: ApplicationStatus.NEW,
    },
    {
      fullName: 'Каримова Малика',
      phone: '+992 901 222 333',
      direction: Direction.LANGUAGE,
      comment: 'Хочу пройти языковую программу в Германии.',
      status: ApplicationStatus.IN_PROGRESS,
    },
    {
      fullName: 'Раджабов Фаррух',
      phone: '+992 555 777 888',
      email: 'farr@example.com',
      direction: Direction.MASTER,
      comment: 'Магистратура в Южной Корее, IT-направление.',
      status: ApplicationStatus.NEW,
    },
  ];

  for (const a of demoApps) {
    const exists = await prisma.application.findFirst({ where: { phone: a.phone } });
    if (!exists) {
      await prisma.application.create({ data: a });
    }
  }

  console.log('✅ Seed complete.');
  console.log('   Admin:    admin@javonon.local / admin123');
  console.log('   Employee: employee@javonon.local / employee123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
