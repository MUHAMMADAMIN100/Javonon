/**
 * Безопасное создание уникального индекса SalaryRecord(userId, periodStart).
 *
 * Зачем этот скрипт существует.
 * В схему добавлено `@@unique([userId, periodStart])` на SalaryRecord — это
 * БД-гард от двойного начисления комиссии. Бонус менеджера считается за
 * КАЛЕНДАРНЫЙ МЕСЯЦ; из месячной комиссии вычитается сумма bonusAmount уже
 * существующих записей этого месяца. Такая проверка — классический
 * read-then-write: два одновременных POST /salary за один и тот же период
 * (двойной клик по «Зафиксировать», ретрай запроса после таймаута) оба видели
 * bonusAlreadyPaid = 0 и оба писали ПОЛНУЮ месячную комиссию. Менеджер получал
 * комиссию дважды, а markPaid резал под каждую строку отдельную расходную
 * SALARY-транзакцию — расходилась и зарплата, и финансовая отчётность.
 * Прикладной код теперь делает агрегат и вставку одной SERIALIZABLE
 * транзакцией (salary.service.ts), а этот индекс — второй рубеж: две строки
 * на одного сотрудника с одинаковым periodStart физически невозможны.
 *
 * Несколько записей ВНУТРИ месяца (аванс + окончательный расчёт) индекс не
 * ломает — у них разный periodStart. Он ловит ровно дубль одного и того же
 * периода.
 *
 * Почему без него деплой падал бы.
 * `prisma db push` считает добавление уникального ограничения потенциально
 * разрушительным: статически он не знает, есть ли в таблице конфликтующие
 * пары, поэтому печатает «There might be data loss» и требует
 * `--accept-data-loss`. Этот флаг намеренно убран из `start:prod` (см.
 * DEPLOY.md) — он подавляет ВСЕ предупреждения, включая настоящие удаления
 * колонок при откате кода. Точно та же история уже решена для Commission
 * (ensure-commission-unique.ts) — здесь тот же приём.
 *
 * Что делает скрипт (запускается ДО `prisma db push`):
 *   • нет конфликтующих пар  → CREATE UNIQUE INDEX. После этого db push видит
 *     индекс, совпадающий со схемой, разницы нет — предупреждения не будет.
 *   • есть конфликтующие пары → индекс НЕ создаётся, в лог уходит список
 *     конкретных пар. Деплой упрётся в предупреждение db push, но уже с
 *     понятной причиной в логе: значит, кому-то реально начислили зарплату
 *     дважды за один период, и это надо разобрать руками (лишний DRAFT
 *     удалить), а не подавлять флагом. ИСТОРИЧЕСКИЕ ЗАПИСИ СКРИПТ НЕ ТРОГАЕТ
 *     И НЕ ПЕРЕСЧИТЫВАЕТ — только сообщает.
 *
 * Идемпотентно: `IF NOT EXISTS` — повторный прогон ничего не делает.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Имя ровно то, которое Prisma генерирует для `@@unique([userId, periodStart])`
 * на модели SalaryRecord. Если назвать иначе, db push не найдёт «свой» индекс
 * и всё равно попытается создать нужный — смысл скрипта потеряется.
 */
const INDEX_NAME = 'SalaryRecord_userId_periodStart_key';

type DuplicateRow = {
  userId: string;
  periodStart: Date;
  cnt: bigint;
};

async function main() {
  console.log('🔎 Проверка SalaryRecord(userId, periodStart) перед db push...');

  // Таблицы может ещё не быть — на свежей базе db push создаст её сам,
  // и индекс приедет вместе с ней, без предупреждения.
  const tableExists = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'SalaryRecord'
    ) AS "exists"
  `;
  if (!tableExists[0]?.exists) {
    console.log('  · Таблица SalaryRecord ещё не создана — пропуск, её создаст db push');
    return;
  }

  const duplicates = await prisma.$queryRaw<DuplicateRow[]>`
    SELECT "userId", "periodStart", COUNT(*) AS cnt
    FROM "SalaryRecord"
    GROUP BY "userId", "periodStart"
    HAVING COUNT(*) > 1
  `;

  if (duplicates.length > 0) {
    console.warn('  ! Найдены дубли зарплатных записей — уникальный индекс НЕ создан:');
    for (const d of duplicates) {
      console.warn(
        `    userId=${d.userId} periodStart=${d.periodStart?.toISOString?.() ?? d.periodStart} — записей: ${d.cnt}`,
      );
    }
    console.warn('  ! Это значит, что за один и тот же период зарплата начислена больше одного раза.');
    console.warn('  ! Разберите дубли (лишнюю DRAFT-запись удалить) и запустите деплой заново.');
    console.warn('  ! Флагом --accept-data-loss это подавлять НЕЛЬЗЯ: он снимает');
    console.warn('  ! защиту и от настоящих удалений колонок при откате кода.');
    return;
  }

  // Конфликтов нет — создаём индекс сами, до того как db push успеет
  // испугаться. CONCURRENTLY не используем намеренно: он не работает внутри
  // транзакции, а таблица маленькая (зарплатных строк — сотни), блокировка на
  // доли секунды роли не играет.
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "SalaryRecord" ("userId", "periodStart")`,
  );
  console.log(`  ✓ Уникальный индекс ${INDEX_NAME} на месте`);
}

main()
  .catch((e) => {
    // Не валим деплой: цепочка в start:prod обёрнута в `|| echo`, но явно
    // сообщаем причину — молчаливое падение читалось бы как «db push сломался».
    console.error('  ! ensure-salary-unique не отработал:', e?.message ?? e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
