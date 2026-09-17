/**
 * ТЕСТОВЫЕ ДАННЫЕ для проверки массового назначения менеджера лидам
 * (PATCH /applications/bulk/manager, экран /leads).
 *
 * Создаёт трёх менеджеров, одного деактивированного, одного рядового
 * сотрудника без права раздавать лиды и 60 лидов NEW_LEAD (часть уже
 * назначена, один — со связанным студентом). Перезапуск приводит лиды в
 * исходное состояние.
 *
 * РАБОТАЕТ ТОЛЬКО С ЛОКАЛЬНОЙ ТЕСТОВОЙ БАЗОЙ: скрипт удаляет и создаёт
 * строки, поэтому на любой DATABASE_URL, кроме 127.0.0.1:5433/javonon_e2e,
 * он отказывается стартовать. Поднять базу:
 *   createdb -h 127.0.0.1 -p 5433 -U postgres javonon_e2e
 *   npx prisma db push && npx ts-node prisma/seed.ts
 *   npx ts-node -T scripts/e2e-bulk-assign-fixtures.ts
 * Затем запустить backend и прогнать scripts/e2e-bulk-assign-api.ts.
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const url = process.env.DATABASE_URL || '';
if (!/@127\.0\.0\.1:5433\/javonon_e2e/.test(url)) {
  console.error('ОТКАЗ: фикстуры пишутся только в локальную javonon_e2e (127.0.0.1:5433).');
  process.exit(1);
}

const prisma = new PrismaClient();

async function upsertUser(email: string, fullName: string, role: Role, isActive = true) {
  const password = await bcrypt.hash('test12345', 10);
  return prisma.user.upsert({
    where: { email },
    update: { fullName, role, roles: [role], isActive },
    create: { email, fullName, role, roles: [role], isActive, password },
  });
}

async function main() {
  const mA = await upsertUser('mgr.a@e2e.local', 'Тест Менеджер А', Role.SALES_MANAGER);
  const mB = await upsertUser('mgr.b@e2e.local', 'Тест Менеджер Б', Role.SALES_MANAGER);
  const mC = await upsertUser('mgr.c@e2e.local', 'Тест Менеджер В', Role.CLIENT_MANAGER);
  const fired = await upsertUser('mgr.fired@e2e.local', 'Тест Уволенный', Role.SALES_MANAGER, false);
  // Рядовой менеджер БЕЗ права раздавать лиды: может взять свободный лид себе.
  const plain = await upsertUser('plain@e2e.local', 'Тест Рядовой', Role.SALES_MANAGER);

  // Чистый лист: только лиды этого скрипта.
  await prisma.application.deleteMany({ where: { fullName: { startsWith: 'Лид ' } } });
  await prisma.student.deleteMany({ where: { fullName: { startsWith: 'Студент-лид ' } } });

  const base = Date.now();
  for (let i = 1; i <= 60; i++) {
    const n = String(i).padStart(2, '0');
    // Лид 01 — самый новый (сверху списка), Лид 60 — самый старый.
    const createdAt = new Date(base - i * 60_000);
    let managerId: string | null = null;
    if (i >= 11 && i <= 13) managerId = mB.id; // 3 лида уже у «Б»
    if (i >= 14 && i <= 15) managerId = mC.id; // 2 лида уже у «В»
    let studentId: string | null = null;
    if (i === 5) {
      // Лид со связанным студентом — проверяем зеркалирование менеджера.
      const st = await prisma.student.create({
        data: { fullName: `Студент-лид ${n}`, direction: 'BACHELOR', cabinet: 1 },
      });
      studentId = st.id;
    }
    await prisma.application.create({
      data: {
        fullName: `Лид ${n}`,
        phone: `+99290000${String(1000 + i)}`,
        direction: 'BACHELOR',
        directionConfirmed: false,
        country: i % 2 ? 'USA' : 'CHINA',
        source: 'OTHER',
        status: 'NEW_LEAD',
        managerId,
        studentId,
        createdAt,
      },
    });
  }
  const total = await prisma.application.count({ where: { status: 'NEW_LEAD' } });
  console.log('Готово. Лидов NEW_LEAD:', total);
  console.log(JSON.stringify({ mA: mA.id, mB: mB.id, mC: mC.id, fired: fired.id, plain: plain.id }));
}

main()
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
