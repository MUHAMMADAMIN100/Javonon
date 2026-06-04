/**
 * Миграция ролей: EMPLOYEE → SALES_MANAGER + добавление FOUNDER/SALES_MANAGER/
 * CLIENT_MANAGER в enum.
 *
 * Запускается в start:prod ДО `prisma db push`. Без этого скрипта db push
 * упал бы при попытке убрать значение EMPLOYEE из enum, пока в таблице
 * User есть строки с этим значением.
 *
 * Логика:
 *   1. Добавить новые enum-значения (ALTER TYPE Role ADD VALUE IF NOT EXISTS).
 *      Постгрес позволяет добавлять значения в существующий enum без потери
 *      данных, в отличие от удаления.
 *   2. UPDATE User SET role='SALES_MANAGER' WHERE role='EMPLOYEE' — переводим
 *      всех существующих сотрудников в новую роль.
 *   3. После этого db push --accept-data-loss спокойно уберёт EMPLOYEE из
 *      enum, потому что больше никто его не использует.
 *
 * Идемпотентно: при повторных запусках просто ничего не делает.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_ROLE_VALUES = ['FOUNDER', 'SALES_MANAGER', 'CLIENT_MANAGER'];

async function main() {
  console.log('🔄 Migrating roles...');

  // 1. Добавляем новые значения в enum. Каждое — в своей транзакции,
  // потому что Postgres требует commit перед использованием нового значения.
  for (const value of NEW_ROLE_VALUES) {
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS '${value}'`,
      );
      console.log(`  ✓ Role enum value ensured: ${value}`);
    } catch (e: any) {
      // Если самого типа Role ещё нет (свежая БД до первого db push) —
      // молча пропускаем: db push создаст enum уже с новыми значениями.
      if (/does not exist/i.test(e.message || '')) {
        console.log(`  · Role enum not yet created — skip (will be created by db push)`);
        return;
      }
      throw e;
    }
  }

  // 2. Переводим всех EMPLOYEE в SALES_MANAGER.
  try {
    const count = await prisma.$executeRawUnsafe(
      `UPDATE "User" SET "role"='SALES_MANAGER' WHERE "role"='EMPLOYEE'`,
    );
    if (count > 0) {
      console.log(`  ✓ Migrated ${count} EMPLOYEE users → SALES_MANAGER`);
    } else {
      console.log(`  · No EMPLOYEE users to migrate`);
    }
  } catch (e: any) {
    // EMPLOYEE уже могло быть убрано из enum — это норма.
    if (/invalid input value for enum/i.test(e.message || '')) {
      console.log(`  · EMPLOYEE already removed from enum — skip`);
    } else {
      console.warn(`  ! User role migration warning: ${e.message}`);
    }
  }

  // 3. КРИТИЧНО: меняем DEFAULT колонки User.role с EMPLOYEE на SALES_MANAGER.
  // Без этого Postgres не даёт дропнуть значение EMPLOYEE из enum, потому
  // что оно используется как default. Prisma db push не делает этот ALTER
  // в правильном порядке и падает с «column ... default ... references ...».
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'SALES_MANAGER'`,
    );
    console.log(`  ✓ User.role default → SALES_MANAGER`);
  } catch (e: any) {
    if (/does not exist/i.test(e.message || '')) {
      console.log(`  · User table not yet exists — skip default change`);
    } else {
      console.warn(`  ! Failed to set default: ${e.message}`);
    }
  }

  // 4. Создаём колонку User.roles ЗАРАНЕЕ. Когда Prisma db push видит
  // одновременное изменение enum + добавление новой колонки того же
  // enum-типа, у него ломается порядок миграции и он жалуется на
  // «column roles does not exist» во время AlterEnum. Если колонка уже
  // существует — он просто пропустит её создание.
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "roles" "Role"[] NOT NULL DEFAULT '{}'::"Role"[]`,
    );
    console.log(`  ✓ User.roles column ensured`);
  } catch (e: any) {
    if (/does not exist/i.test(e.message || '')) {
      console.log(`  · User table or Role type not yet exists — skip roles column`);
    } else {
      console.warn(`  ! Failed to add roles column: ${e.message}`);
    }
  }

  console.log('✅ Role migration complete.');
}

main()
  .catch((e) => {
    console.error('Role migration failed:', e);
    // НЕ роняем процесс — start:prod продолжит и даст шанс db push разобраться.
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
