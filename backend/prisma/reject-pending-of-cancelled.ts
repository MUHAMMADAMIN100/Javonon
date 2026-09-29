/**
 * Неодобренные платежи уже отменённых сделок → REJECTED.
 *
 * До этой правки отмена сделки откатывала только ОДОБРЕННЫЕ платежи, а
 * неодобренные оставались PENDING навсегда: одобрить нельзя («сделка
 * отменена»), отклонить нельзя («неактивная сделка»), и сделка вечно висела во
 * вкладке «На рассмотрении». Теперь changeStatus отклоняет их сам (шаг 7 в
 * submissions.service.ts), а этот скрипт закрывает уже зависшие.
 *
 * Меняется только статус и причина — денег по таким платежам не было, ничего
 * не удаляется; updatedAt не трогаем (UPDATE мимо Prisma-клиента).
 * Идемпотентно: повторный запуск таких строк уже не находит.
 *
 * REJECTED старый контейнер при выкатке читает как обычно — скрипт не опт-ин.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Неодобренные платежи отменённых сделок...');
  try {
    const count = await prisma.$executeRaw`
      UPDATE "SubmissionPayment" p
         SET "status" = 'REJECTED',
             "reviewedAt" = NOW(),
             "rejectReason" = 'Сделка отменена (закрыто автоматически)'
        FROM "SaleSubmission" s
       WHERE s."id" = p."submissionId"
         AND s."status" = 'CANCELLED'
         AND p."status" = 'PENDING'
    `;
    console.log(count > 0 ? `  ✓ отклонено: ${count}` : '  · таких платежей нет — пропуск');
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
    console.error('Cancelled pending cleanup failed:', e);
    // НЕ роняем процесс — деплой должен подняться даже если скрипт не зашёл.
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
