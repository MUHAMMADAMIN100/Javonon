/**
 * Миграция дат рождения: душанбинская полночь → UTC-полночь.
 *
 * Предыстория. Application.birthday писался через tjParseLocalDate(), то есть
 * «12.03.2006» ложилось в БД как `2006-03-11T19:00:00.000Z` (полночь по
 * Душанбе = 19:00 UTC предыдущих суток). Student.birthday из CRM писался через
 * `new Date('2006-03-12')` = `2006-03-12T00:00:00.000Z`. Две конвенции в одной
 * колонке, причём Application.birthday копируется в Student.birthday при
 * конвертации заявки — так смесь расползалась дальше.
 *
 * Ломалось это в двух местах:
 *   1. cron birthdayGreetings — `EXTRACT(DAY FROM birthday)` читает сырую
 *      UTC-колонку и для «19:00Z»-строк возвращает ВЧЕРАШНЕЕ число, поэтому
 *      SMS-поздравление лидам с лендинга уходило на сутки раньше;
 *   2. CRM, где дата рождения местами читается как ISO-префикс
 *      (`birthday.slice(0, 10)`) — показывала 11.03 вместо 12.03.
 *
 * Код починен (см. parseCalendarDateUtc в src/common/tj-time.ts), эта
 * миграция чинит уже накопленные строки: сдвигает на +5 часов ровно те, что
 * стоят на 19:00:00 — то есть записанные старой конвенцией.
 *
 * Идемпотентно: после сдвига час становится 0, повторный запуск таких строк
 * уже не видит. Строки, записанные правильно (00:00:00), не трогаются.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Ровно 19:00:00.000 — подпись старой конвенции (Asia/Dushanbe = UTC+5 без
// DST, так что душанбинская полночь всегда даёт ровно этот час). Проверяем и
// минуты/секунды/миллисекунды, чтобы не задеть какой-нибудь ручной ввод с
// временем, если он когда-нибудь появится.
const LEGACY_TIME_PREDICATE = `
  "birthday" IS NOT NULL
  AND EXTRACT(HOUR FROM "birthday") = 19
  AND EXTRACT(MINUTE FROM "birthday") = 0
  AND EXTRACT(SECOND FROM "birthday") = 0
`;

async function shiftTable(table: 'Application' | 'Student'): Promise<void> {
  try {
    const count = await prisma.$executeRawUnsafe(
      `UPDATE "${table}"
          SET "birthday" = "birthday" + INTERVAL '5 hours'
        WHERE ${LEGACY_TIME_PREDICATE}`,
    );
    if (count > 0) {
      console.log(`  ✓ ${table}.birthday: ${count} строк сдвинуто на UTC-полночь`);
    } else {
      console.log(`  · ${table}.birthday: строк старой конвенции нет — пропуск`);
    }
  } catch (e: any) {
    // Свежая БД до первого `prisma db push` — таблицы/колонки ещё нет.
    if (/does not exist/i.test(e?.message || '')) {
      console.log(`  · ${table} ещё не создана — пропуск`);
      return;
    }
    console.warn(`  ! ${table}.birthday migration warning: ${e?.message}`);
  }
}

async function main() {
  console.log('🔄 Normalizing birthdays to UTC midnight...');
  await shiftTable('Application');
  await shiftTable('Student');
  console.log('✅ Birthday migration complete.');
}

main()
  .catch((e) => {
    console.error('Birthday migration failed:', e);
    // НЕ роняем процесс — деплой должен подняться даже если миграция не зашла.
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
