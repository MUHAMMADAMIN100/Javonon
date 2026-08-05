/**
 * Безопасное создание уникального индекса Commission(partnerId, studentId).
 *
 * Зачем этот скрипт вообще существует.
 * В схему добавлено `@@unique([partnerId, studentId])` на Commission — это
 * БД-гард правила основателя «партнёру платим один раз за клиента». Он нужен
 * именно на уровне базы: строк ReferralAttribution на одного клиента бывает
 * несколько (человек дважды отправил форму с реферальной ссылки), и
 * прикладная дедупликация по одной строке такую пару пропускает.
 *
 * Почему без него деплой падал.
 * `prisma db push` считает добавление уникального ограничения потенциально
 * разрушительным: он не может статически знать, есть ли в таблице конфликтующие
 * пары, поэтому печатает «There might be data loss» и требует
 * `--accept-data-loss`. Этот флаг мы намеренно убрали из `start:prod` (см.
 * DEPLOY.md) — он подавляет ВСЕ предупреждения, включая настоящие удаления
 * колонок при откате кода. Возвращать его ради одного индекса нельзя.
 *
 * Что делает скрипт.
 * Запускается ДО `prisma db push`. Сам проверяет то, что Prisma проверить не
 * может, и создаёт индекс явным SQL:
 *   • нет конфликтующих пар  → CREATE UNIQUE INDEX. После этого `db push`
 *     видит индекс, совпадающий со схемой, разницы нет — предупреждение не
 *     возникает, деплой идёт дальше.
 *   • есть конфликтующие пары → индекс НЕ создаётся, в лог уходит список
 *     конкретных пар. Деплой упрётся в то же предупреждение от `db push`, но
 *     уже с понятной причиной в логе: значит, кому-то реально начислили
 *     дважды за одного клиента, и это надо разобрать руками, а не подавлять
 *     флагом.
 *
 * Про NULL. У всех строк, созданных до появления партнёрских начислений по
 * сделкам, `studentId` пустой. В Postgres пустые значения в уникальном индексе
 * между собой не конфликтуют, поэтому такие строки ограничению не мешают —
 * именно поэтому проверка ниже смотрит только на строки с заполненным
 * studentId.
 *
 * Идемпотентно: `IF NOT EXISTS` — повторный прогон ничего не делает.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Имя ровно то, которое Prisma генерирует для `@@unique([partnerId, studentId])`
 * на модели Commission. Если назвать иначе, `db push` увидит «чужой» индекс,
 * не найдёт свой — и всё равно попытается создать нужный, то есть смысл
 * скрипта потеряется.
 */
const INDEX_NAME = 'Commission_partnerId_studentId_key';

type DuplicateRow = {
  partnerId: string;
  studentId: string;
  cnt: bigint;
};

async function main() {
  console.log('🔎 Проверка Commission(partnerId, studentId) перед db push...');

  // Таблицы может ещё не быть — на совсем свежей базе db push создаст её сам,
  // и тогда индекс приедет вместе с ней, без всякого предупреждения.
  const tableExists = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'Commission'
    ) AS "exists"
  `;
  if (!tableExists[0]?.exists) {
    console.log('  · Таблица Commission ещё не создана — пропуск, её создаст db push');
    return;
  }

  // Колонка studentId сама по себе НОВАЯ — её добавляет тот же db push, который
  // спотыкается об индекс. Получается замкнутый круг: проверить дубликаты
  // нельзя, потому что колонки ещё нет, а колонка не появится, потому что
  // db push останавливается на индексе. Поэтому создаём её здесь.
  //
  // Это безопасно и по сути не «миграция руками»: колонка nullable, без связи и
  // без значения по умолчанию, то есть добавление никаких данных не трогает.
  // Ровно то же самое сделал бы db push, просто на шаг позже.
  //
  // Заодно отсюда следует главное: раз колонка новая, у ВСЕХ существующих строк
  // она пустая, а значит конфликтующих пар не бывает по определению — проверка
  // ниже это подтверждает, а не выясняет.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Commission" ADD COLUMN IF NOT EXISTS "studentId" TEXT`,
  );

  const duplicates = await prisma.$queryRaw<DuplicateRow[]>`
    SELECT "partnerId", "studentId", COUNT(*) AS cnt
    FROM "Commission"
    WHERE "studentId" IS NOT NULL
    GROUP BY "partnerId", "studentId"
    HAVING COUNT(*) > 1
  `;

  if (duplicates.length > 0) {
    console.warn('  ! Найдены конфликтующие пары — уникальный индекс НЕ создан:');
    for (const d of duplicates) {
      console.warn(
        `    partnerId=${d.partnerId} studentId=${d.studentId} — начислений: ${d.cnt}`,
      );
    }
    console.warn(
      '  ! Это значит, что за одного клиента партнёру начислено больше одного раза.',
    );
    console.warn(
      '  ! Разберите дубликаты (лишние перевести в REVERSED) и запустите деплой заново.',
    );
    console.warn('  ! Флагом --accept-data-loss это подавлять НЕЛЬЗЯ: он снимает');
    console.warn('  ! защиту и от настоящих удалений колонок при откате кода.');
    return;
  }

  // Конфликтов нет — создаём индекс сами, до того как db push успеет
  // испугаться. CONCURRENTLY не используем намеренно: он не работает внутри
  // транзакции, а таблица маленькая (начисления — единицы строк), блокировка
  // на доли секунды роли не играет.
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "Commission" ("partnerId", "studentId")`,
  );
  console.log(`  ✓ Уникальный индекс ${INDEX_NAME} на месте`);
}

main()
  .catch((e) => {
    // Не валим деплой: цепочка в start:prod обёрнута в `|| echo`, но на всякий
    // случай явно сообщаем причину — молчаливое падение здесь читалось бы как
    // «db push сам по себе сломался».
    console.error('  ! ensure-commission-unique не отработал:', e?.message ?? e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
