/**
 * ТЕСТОВЫЕ ДАННЫЕ для проверки поиска и фильтров на экране «Сделки».
 *
 * Шесть сделок, в которых клиент лежит во всех местах, где он бывает:
 * существующий студент (имя + phones[]), новый клиент прямо в сделке
 * (newStudentName/Phone), клиент только из заявки (телефон — у заявки).
 * Разные менеджеры, программы, даты создания; четыре платежа на
 * рассмотрении с разными датами оплаты; одна сделка — клиент партнёра.
 * Перезапуск удаляет прошлый прогон (по пометке в notes) и создаёт заново.
 *
 * РАБОТАЕТ ТОЛЬКО С ЛОКАЛЬНОЙ ТЕСТОВОЙ БАЗОЙ javonon_e2e.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5455/javonon_e2e \
 *     npx ts-node -T scripts/e2e-deals-fixtures.ts
 */
import 'dotenv/config';
import { Direction, PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL || '';
if (!/@127\.0\.0\.1:\d+\/javonon_e2e$/.test(url)) {
  console.error('ОТКАЗ: фикстуры пишутся только в локальную javonon_e2e.');
  process.exit(1);
}

const prisma = new PrismaClient();
const MARK = 'СДЕЛКИ-ТЕСТ';
const sep = (d: number) => new Date(Date.UTC(2026, 8, d, 5, 0, 0)); // сентябрь 2026, 10:00 Душанбе
const aug = (d: number) => new Date(Date.UTC(2026, 7, d, 5, 0, 0));

async function main() {
  const mgrA = await prisma.user.findUniqueOrThrow({ where: { email: 'mgr.a@e2e.local' } });
  const mgrB = await prisma.user.findUniqueOrThrow({ where: { email: 'mgr.b@e2e.local' } });
  const searchMgr = await prisma.user.findUniqueOrThrow({ where: { email: 'search.mgr@e2e.local' } });
  const partner = await prisma.partner.findUniqueOrThrow({ where: { email: 'sort-zarina@e2e.local' } });

  // --- чистка ---
  const old = await prisma.saleSubmission.findMany({ where: { notes: MARK }, select: { id: true } });
  await prisma.submissionPayment.deleteMany({ where: { submissionId: { in: old.map((o) => o.id) } } });
  await prisma.saleSubmission.deleteMany({ where: { notes: MARK } });
  await prisma.referralAttribution.deleteMany({ where: { emailHint: MARK } });
  await prisma.student.deleteMany({ where: { comment: MARK } });
  await prisma.application.deleteMany({ where: { comment: MARK } });
  await prisma.program.deleteMany({ where: { description: MARK } });

  const progAll = await prisma.program.create({
    data: { name: 'Академия все включено', university: 'Deals U', city: 'Шанхай', major: 'Lang', direction: Direction.LANGUAGE, cost: 9000, description: MARK },
  });
  const progNoIelts = await prisma.program.create({
    data: { name: 'Академия без IELTS', university: 'Deals U', city: 'Шанхай', major: 'Lang', direction: Direction.LANGUAGE, cost: 7000, description: MARK },
  });

  const stAbdullaev = await prisma.student.create({
    data: {
      fullName: 'Абдуллаев Абдулочон Нусратьулоевич', direction: Direction.LANGUAGE, cabinet: 1, comment: MARK,
      phones: ['+992 91 700 11 22', '+79035550011'],
    },
  });
  const stPartner = await prisma.student.create({
    data: { fullName: 'Кабиров Мухаммад Довудович', direction: Direction.LANGUAGE, cabinet: 1, comment: MARK, phones: ['+992930001122'] },
  });
  // Клиент партнёра: привязка по студенту.
  await prisma.referralAttribution.create({ data: { partnerId: partner.id, studentId: stPartner.id, emailHint: MARK } });
  // Клиент только из заявки: телефон лежит у заявки, в сделке его нет.
  const app = await prisma.application.create({
    data: { fullName: 'Давлатзода Сумая', phone: '+992 55 444 33 22', direction: Direction.LANGUAGE, comment: MARK, status: 'IN_PROCESSING' },
  });

  const deals = [
    { key: 'latipov', newStudentName: 'Латипов Зайдулло', newStudentPhone: '+992 93 555 12 34', managerId: searchMgr.id, programId: progAll.id, createdAt: sep(12), pay: { amount: 1500, paidAt: sep(14) } },
    { key: 'abdullaev', studentId: stAbdullaev.id, managerId: mgrA.id, programId: progAll.id, createdAt: sep(10), pay: { amount: 10000, paidAt: sep(14) } },
    { key: 'zakrieva', newStudentName: 'Закриёва Зулайхо', newStudentPhone: '+992-90-777-88-99', managerId: mgrB.id, programId: progNoIelts.id, createdAt: sep(5), pay: { amount: 4000, paidAt: sep(8) } },
    { key: 'davlatzoda', newStudentName: 'Давлатзода Сумая', sourceApplicationId: app.id, managerId: mgrA.id, programId: progAll.id, createdAt: sep(2), pay: { amount: 6000, paidAt: sep(4) } },
    { key: 'kabirov', studentId: stPartner.id, managerId: mgrB.id, programId: progNoIelts.id, createdAt: aug(25), approved: true },
    { key: 'yusupov', newStudentName: 'Yusupov Farrukh', newStudentPhone: '+998901234567', managerId: mgrA.id, programId: null, createdAt: aug(15), approved: true },
  ];
  for (const d of deals) {
    const s = await prisma.saleSubmission.create({
      data: {
        studentId: d.studentId ?? null,
        newStudentName: d.newStudentName ?? null,
        newStudentPhone: d.newStudentPhone ?? null,
        sourceApplicationId: d.sourceApplicationId ?? null,
        managerId: d.managerId,
        programId: d.programId,
        totalAmount: 9000,
        currency: 'TJS',
        notes: MARK,
        createdAt: d.createdAt,
        firstApprovedAt: d.approved ? new Date(d.createdAt.getTime() + 86400_000) : null,
      },
    });
    if (d.pay) {
      await prisma.submissionPayment.create({
        data: { submissionId: s.id, amount: d.pay.amount, paidAt: d.pay.paidAt, status: 'PENDING', paymentMethod: 'TRANSFER' },
      });
    }
    if (d.approved) {
      await prisma.submissionPayment.create({
        data: { submissionId: s.id, amount: 3000, paidAt: d.createdAt, status: 'APPROVED', paymentMethod: 'CASH' },
      });
    }
  }
  // --- таблица платежей: у «Латипова» платежи во всех состояниях ---
  const latipov = await prisma.saleSubmission.findFirstOrThrow({ where: { notes: MARK, newStudentName: 'Латипов Зайдулло' } });
  await prisma.submissionPayment.updateMany({
    where: { submissionId: latipov.id },
    data: { depositProofUrls: ['/uploads/e2e-deposit.jpg'], nextDueDate: sep(28), nextDueAmount: 6000 },
  });
  await prisma.submissionPayment.create({
    data: {
      submissionId: latipov.id, amount: 3000, paidAt: sep(1), status: 'APPROVED', paymentMethod: 'TRANSFER',
      receiptUrls: ['/uploads/e2e-receipt-1.jpg', '/uploads/e2e-receipt-2.jpg'], notes: 'Первый взнос, перевод Alif',
    },
  });
  await prisma.submissionPayment.create({
    data: {
      submissionId: latipov.id, amount: 500, paidAt: sep(3), status: 'REJECTED', paymentMethod: 'CASH',
      rejectReason: 'Чек не читается',
    },
  });
  // Телефон партнёра — для поиска по номеру на «Партнёрах».
  await prisma.partner.update({ where: { id: partner.id }, data: { phone: '+992 90 123 45 67' } });

  console.log('OK: сделки для проверки поиска и фильтров созданы');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
