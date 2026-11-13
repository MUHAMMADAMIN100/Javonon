/**
 * Перевод колонок справочников с enum'ов Postgres на текст (13.11.2026).
 *
 * Зачем. Статусы лидов, направления, страны и источники стали справочником
 * (LookupItem, «Лиды → Настройки»): основатель сам добавляет значения, и
 * значение больше не обязано быть одним из зашитых enum'ов. В schema.prisma
 * эти поля теперь `String`.
 *
 * Почему отдельным скриптом ДО `prisma db push`. Смену типа колонки
 * enum → String db push выполняет как DROP COLUMN + ADD COLUMN (данные
 * теряются) и без `--accept-data-loss` отказывается — а этот флаг намеренно
 * убран из start:prod. Здесь тип меняется на месте:
 * `ALTER COLUMN … TYPE text USING …::text` — значения сохраняются как были
 * (NEW_LEAD, KOREA, …). После этого db push видит text = String, разницы
 * нет; остаётся только убрать ставшие ненужными типы enum'ов.
 *
 * Идемпотентно: колонка, которая уже text, пропускается.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** [таблица, колонка, новое значение по умолчанию или null]. */
const COLUMNS: Array<[string, string, string | null]> = [
  ['Application', 'status', 'NEW_LEAD'],
  ['Application', 'statusBeforeDeal', null],
  ['Application', 'direction', null],
  ['Application', 'country', null],
  ['Application', 'source', 'LANDING_FORM'],
  ['Student', 'direction', null],
  ['Student', 'country', null],
  ['Program', 'direction', null],
];

const ENUM_TYPES = ['ApplicationStatus', 'Direction', 'Country', 'ApplicationSource'];

async function main() {
  console.log('🔎 Справочники: колонки enum → text перед db push...');
  let changed = 0;
  for (const [table, column, def] of COLUMNS) {
    const rows = await prisma.$queryRaw<Array<{ data_type: string }>>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    `;
    const type = rows[0]?.data_type;
    if (!type) {
      console.log(`  · ${table}.${column}: колонки нет — её создаст db push`);
      continue;
    }
    if (type !== 'USER-DEFINED') {
      console.log(`  · ${table}.${column}: уже ${type}`);
      continue;
    }
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE text USING "${column}"::text`);
    if (def) await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT '${def}'`);
    changed++;
    console.log(`  ✓ ${table}.${column}: enum → text`);
  }
  // Типы больше ни на что не ссылаются — убираем, чтобы db push не спотыкался о них.
  for (const t of ENUM_TYPES) {
    const used = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND udt_name = ${t}
    `;
    if ((used[0]?.n ?? 0) === 0) await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "${t}"`);
  }
  console.log(`✅ Справочники: переведено колонок — ${changed}`);
}

main()
  .catch((e) => {
    console.error('❌ lookups-enum-to-text:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
