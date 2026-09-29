/**
 * Бонус по месяцу ОПЛАТЫ: перевод платежей, одобренных 26–29.09.2026 по
 * правилу «месяц одобрения», на месяц оплаты (решение учредителя 2026-09-29).
 *
 * С 26.09 approvePayment писал SubmissionPayment.bonusMonthBy = 'APPROVAL' —
 * платёж ложился в бонус того месяца, когда его одобрили. Учредитель вернул
 * правило «по дате оплаты» (common/manager-bonus-volume.ts). Такие строки
 * переводим на 'PAYMENT', КРОМЕ тех, что уже вошли в зафиксированную зарплату
 * месяца одобрения: есть зарплатная запись менеджера, задевающая месяц
 * одобрения и созданная после одобрения, — значит, бонус за платёж уже
 * начислен в том месяце. Такой платёж остаётся 'APPROVAL', иначе он ушёл бы в
 * месяц оплаты и был бы начислен второй раз (доплатой за прошлый месяц).
 *
 * Меняется только служебная пометка bonusMonthBy — ничего не удаляется,
 * updatedAt платежа не трогаем (UPDATE мимо Prisma-клиента).
 *
 * Идемпотентно: повторный запуск видит только оставшиеся 'APPROVAL'-строки и
 * проверяет их заново. Если черновик зарплаты, из-за которого строку оставили,
 * потом удалили, — при следующем запуске она переведётся: удалённый черновик
 * ничего не выплатил, и платёж честно уходит в месяц оплаты.
 *
 * Старый контейнер во время выкатки читает 'PAYMENT' так же, как и раньше (по
 * paidAt), — падать на чтении нечему, поэтому скрипт не опт-ин (DEPLOY.md,
 * «Бонус по месяцу оплаты»).
 */
import { PrismaClient } from '@prisma/client';
import { tjEndOfMonth, tjStartOfMonth } from '../src/common/tj-time';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Бонус по месяцу оплаты: платежи, одобренные по правилу «месяц одобрения»...');
  let rows: Array<{
    id: string;
    reviewedAt: Date | null;
    creditedManagerId: string | null;
    submission: { managerId: string | null } | null;
  }>;
  try {
    rows = await prisma.submissionPayment.findMany({
      // Только засчитанные в бонус: у отклонённого (в том числе после отмены
      // сделки) пометка ни на что не влияет.
      where: { bonusMonthBy: 'APPROVAL', status: 'APPROVED' },
      select: { id: true, reviewedAt: true, creditedManagerId: true, submission: { select: { managerId: true } } },
    });
  } catch (e: any) {
    // Свежая БД до первого `prisma db push` — колонки ещё нет.
    if (/does not exist/i.test(e?.message || '')) {
      console.log('  · колонки bonusMonthBy ещё нет — пропуск');
      return;
    }
    throw e;
  }
  if (!rows.length) {
    console.log('  · таких платежей нет — пропуск');
    return;
  }

  let moved = 0;
  let kept = 0;
  for (const p of rows) {
    const managerId = p.creditedManagerId ?? p.submission?.managerId ?? null;
    if (managerId && p.reviewedAt) {
      // Зарплата месяца одобрения, зафиксированная после одобрения, уже
      // посчитала этот платёж в том месяце.
      const paidThere = await prisma.salaryRecord.findFirst({
        where: {
          userId: managerId,
          createdAt: { gte: p.reviewedAt },
          periodStart: { lte: tjEndOfMonth(p.reviewedAt) },
          periodEnd: { gte: tjStartOfMonth(p.reviewedAt) },
        },
        select: { id: true },
      });
      if (paidThere) {
        kept++;
        continue;
      }
    }
    // Условие на 'APPROVAL' повторно — на случай параллельного запуска.
    moved += await prisma.$executeRaw`
      UPDATE "SubmissionPayment" SET "bonusMonthBy" = 'PAYMENT'
       WHERE "id" = ${p.id} AND "bonusMonthBy" = 'APPROVAL'
    `;
  }
  console.log(`  ✓ переведено на месяц оплаты: ${moved}; оставлено в месяце одобрения (уже в его зарплате): ${kept}`);
}

main()
  .catch((e) => {
    console.error('Bonus month migration failed:', e);
    // НЕ роняем процесс — деплой должен подняться даже если перенос не зашёл.
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
