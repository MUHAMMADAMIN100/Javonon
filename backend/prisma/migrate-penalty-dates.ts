/**
 * Миграция дат автоматических штрафов за опоздания: «вчерашнее число» → день
 * опоздания.
 *
 * Предыстория. Penalty.date — колонка DATE. Cron писал туда tjStartOfDay(день),
 * то есть душанбинскую полночь = 19:00 UTC ПРЕДЫДУЩИХ суток, а Postgres
 * сохранял от неё только дату. Штраф за опоздание 10.09 жил как 09.09:
 * в профиле — вчерашнее число, опоздание 1-го числа уезжало в зарплату
 * прошлого месяца, а статус причины сверялся с соседним днём. Код починен
 * (см. tjCalendarDay в src/common/tj-time.ts), эта миграция двигает на +1
 * день уже накопленные строки.
 *
 * Какие строки — ровно «старые автоматические»:
 *   1. описание старого формата: «Опоздание N мин · …» /
 *      «Позднее возвращение с обеда N мин · …» (новый код пишет дату в
 *      скобках после минут — «Опоздание N мин (10.09) · …» — и сюда не
 *      попадает; ручные штрафы со своим текстом тоже);
 *   2. у сотрудника в день «дата + 1» есть отметка прихода с тем же
 *      опозданием N минут (утро — lateMinutes, обед — lateLunchMinutes);
 *   3. штраф создан в день «дата + 1» по Душанбе — старый cron работал в
 *      22:00 того самого дня опоздания.
 * Условие 3 делает миграцию идемпотентной: после сдвига дата совпадает с
 * днём создания, и повторный запуск строку уже не видит. Строки, которые
 * писались ещё старее (UTC-полночь — тогда дата была верной), не проходят
 * условие 2/3 и не трогаются.
 *
 * Ничего не удаляется; меняется только Penalty.date.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const KINDS = [
  { reason: 'LATE_ARRIVAL', label: 'Опоздание', minutesColumn: 'lateMinutes' },
  { reason: 'LATE_FROM_LUNCH', label: 'Позднее возвращение с обеда', minutesColumn: 'lateLunchMinutes' },
] as const;

async function main() {
  console.log('🔄 Даты автоматических штрафов за опоздания...');
  try {
    for (const k of KINDS) {
      // Метка и колонка — константы из KINDS выше, не пользовательский ввод.
      const count = await prisma.$executeRawUnsafe(`
        UPDATE "Penalty" p
           SET "date" = p."date" + 1
         WHERE p."reason" = '${k.reason}'
           AND p."details" ~ '^${k.label} [0-9]+ мин · '
           AND (p."createdAt" + INTERVAL '5 hours')::date = p."date" + 1
           AND EXISTS (
             SELECT 1
               FROM "TimeEntry" t
              WHERE t."userId" = p."userId"
                AND (t."clockIn" + INTERVAL '5 hours')::date = p."date" + 1
                AND t."${k.minutesColumn}" = substring(p."details" from '^${k.label} ([0-9]+) мин')::int
           )
      `);
      console.log(count > 0 ? `  ✓ ${k.reason}: сдвинуто на +1 день: ${count}` : `  · ${k.reason}: строк старой даты нет — пропуск`);
    }
  } catch (e: any) {
    // Свежая БД до первого `prisma db push` — таблиц ещё нет.
    if (/does not exist/i.test(e?.message || '')) {
      console.log('  · таблиц ещё нет — пропуск');
      return;
    }
    throw e;
  }
}

main()
  .catch((e) => {
    console.error('Penalty dates migration failed:', e);
    // НЕ роняем процесс — деплой должен подняться даже если скрипт не зашёл.
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
