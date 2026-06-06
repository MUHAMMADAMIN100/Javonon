import { PrismaClient, Role, Direction, ApplicationStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

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
      // Раньше было ApplicationStatus.IN_PROGRESS — legacy enum, который
      // фронт уже не отображает (STATUS_LABEL/BADGE не содержат его).
      // Новый эквивалент — DOCS_REVIEW.
      status: ApplicationStatus.DOCS_REVIEW,
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
