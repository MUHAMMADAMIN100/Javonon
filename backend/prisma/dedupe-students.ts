import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * QA-fix #43: на проде есть дубли Student.email из-за race-condition в register
 * (unique constraint отсутствовал). Перед тем как `prisma db push` создаст
 * unique-индекс, надо удалить дубликаты — иначе db push упадёт.
 *
 * Стратегия: для каждой группы students с одинаковым email оставляем
 * САМОГО СТАРОГО (createdAt asc, первый зарегистрировавшийся), остальных удаляем.
 * Удаление каскадирует Document/Enrollment/Interaction/Payment по схеме.
 * Application имеет SetNull на studentId, так что заявки выживают как история.
 */
async function main() {
  console.log('🧹 Dedupe students by email...');
  const groups = await prisma.student.groupBy({
    by: ['email'],
    where: { email: { not: null } },
    _count: true,
    having: { email: { _count: { gt: 1 } } },
  });
  console.log(`Found ${groups.length} duplicate email groups`);
  let removed = 0;
  for (const g of groups) {
    if (!g.email) continue;
    const dupes = await prisma.student.findMany({
      where: { email: g.email },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, createdAt: true },
    });
    // Оставляем первого
    const keep = dupes[0];
    const toDelete = dupes.slice(1);
    console.log(`  ${g.email}: keep=${keep.id} delete=${toDelete.length}`);
    for (const d of toDelete) {
      await prisma.student.delete({ where: { id: d.id } });
      removed++;
    }
  }
  console.log(`✅ Removed ${removed} duplicate students`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
