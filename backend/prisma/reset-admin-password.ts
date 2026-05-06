/**
 * Одноразовый скрипт аварийного сброса пароля сотрудника CRM.
 *
 * Используется когда пароль в БД сохранён битым (например, остаточный
 * хэш с пробелами от старого бага в change-password до фикса с .trim()).
 *
 * НЕ удаляет данные — только UPDATE поля password у одного юзера.
 *
 * Запуск:
 *   # default — admin@javonon.local → admin123
 *   ts-node prisma/reset-admin-password.ts
 *
 *   # custom через env
 *   RESET_EMAIL=foo@bar.com RESET_PASSWORD=newpass123 ts-node prisma/reset-admin-password.ts
 *
 * На Railway:
 *   railway run --service <backend-service> ts-node backend/prisma/reset-admin-password.ts
 *   или через Railway dashboard → Service → Console.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

async function main() {
  const prisma = new PrismaClient();

  const rawEmail = process.env.RESET_EMAIL || 'admin@javonon.local';
  const rawPassword = process.env.RESET_PASSWORD || 'admin123';

  // Нормализуем так же, как делает login() в auth.service.
  const email = rawEmail.trim().toLowerCase();
  const password = rawPassword.trim();

  if (password.length < 8 && password !== 'admin123') {
    console.error('❌ Пароль должен быть минимум 8 символов (исключение: admin123 для сидов)');
    await prisma.$disconnect();
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`❌ Пользователь "${email}" не найден в БД`);
    console.error('   Проверь email или создай сотрудника через сидер: npm run seed');
    await prisma.$disconnect();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hash },
  });

  console.log(`✅ Пароль для "${email}" (${user.fullName}, ${user.role}) сброшен.`);
  console.log(`   Новый пароль: "${password}"`);
  console.log('   Войди в CRM с этими данными и сразу смени пароль на свой.');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('❌ Ошибка:', e);
  process.exit(1);
});
