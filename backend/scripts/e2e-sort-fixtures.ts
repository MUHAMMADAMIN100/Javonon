/**
 * ТЕСТОВЫЕ ДАННЫЕ для проверки сортировки таблиц CRM.
 *
 * В каждую таблицу, которая в тестовой базе была пустой, кладёт по 3–4
 * строки с намеренно «неудобными» значениями: кириллица вперемешку с
 * латиницей, «Группа 2» и «Группа 10» (числа внутри текста), пустые поля,
 * разные суммы и даты. Перезапуск удаляет прошлый прогон (по пометке СОРТ)
 * и создаёт заново.
 *
 * РАБОТАЕТ ТОЛЬКО С ЛОКАЛЬНОЙ ТЕСТОВОЙ БАЗОЙ javonon_e2e.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5455/javonon_e2e \
 *     npx ts-node -T scripts/e2e-sort-fixtures.ts
 */
import 'dotenv/config';
import { Direction, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const url = process.env.DATABASE_URL || '';
if (!/@127\.0\.0\.1:\d+\/javonon_e2e$/.test(url)) {
  console.error('ОТКАЗ: фикстуры пишутся только в локальную javonon_e2e.');
  process.exit(1);
}

const prisma = new PrismaClient();
const MARK = 'СОРТ';
const day = (n: number) => new Date(Date.UTC(2026, 8, n, 4, 0, 0)); // сентябрь 2026, 09:00 Душанбе

async function main() {
  const founder = await prisma.user.findUniqueOrThrow({ where: { email: 'founder@javonon.local' } });
  const users = await prisma.user.findMany({ where: { email: { in: ['mgr.a@e2e.local', 'mgr.b@e2e.local', 'mgr.c@e2e.local'] } } });
  const students = await prisma.student.findMany({ where: { OR: [{ comment: null }, { comment: { not: MARK } }] }, take: 3, orderBy: { fullName: 'asc' } });

  // --- чистка прошлого прогона ---
  const oldPartners = await prisma.partner.findMany({ where: { email: { startsWith: 'sort-' } }, select: { id: true } });
  const pIds = oldPartners.map((p) => p.id);
  await prisma.commission.deleteMany({ where: { partnerId: { in: pIds } } });
  await prisma.partnerPayout.deleteMany({ where: { partnerId: { in: pIds } } });
  await prisma.referralClick.deleteMany({ where: { partnerId: { in: pIds } } });
  await prisma.referralAttribution.deleteMany({ where: { partnerId: { in: pIds } } });
  await prisma.partner.deleteMany({ where: { id: { in: pIds } } });
  await prisma.studyGroup.deleteMany({ where: { description: MARK } });
  const oldSubs = await prisma.saleSubmission.findMany({ where: { notes: MARK }, select: { id: true } });
  await prisma.paymentStage.deleteMany({ where: { submissionId: { in: oldSubs.map((s) => s.id) } } });
  await prisma.saleSubmission.deleteMany({ where: { notes: MARK } });
  await prisma.program.deleteMany({ where: { description: MARK } });
  await prisma.salaryRecord.deleteMany({ where: { comment: MARK } });
  await prisma.penalty.deleteMany({ where: { details: MARK } });
  await prisma.dailyReport.deleteMany({ where: { challenges: MARK } });
  await prisma.timeEntry.deleteMany({ where: { lateExcuseReason: MARK } });
  await prisma.payment.deleteMany({ where: { comment: { startsWith: MARK } } });

  // --- программа со стипендиями ---
  const program = await prisma.program.create({
    data: {
      name: 'СОРТ Программа', university: 'Test University', city: 'Пекин', major: 'CS',
      direction: Direction.BACHELOR, cost: 5000, currency: 'USD', description: MARK, published: true,
      scholarships: {
        create: [
          { name: 'Юниверситет грант', coverage: 'Частичное', amount: '1 000 USD', deadline: '1 марта' },
          { name: 'CSC Scholarship', coverage: 'Полное', amount: '12 000 USD', deadline: '15 января' },
          { name: 'Альфа стипендия', coverage: null, amount: '500 USD', deadline: null },
        ],
      },
    },
  });

  // --- группы: «2» раньше «10» ---
  const groupNames = ['Группа 10', 'Группа 2', 'Alpha group'];
  for (let i = 0; i < groupNames.length; i++) {
    await prisma.studyGroup.create({
      data: {
        name: groupNames[i],
        description: MARK,
        teacherId: users[i % users.length]?.id,
        programId: i === 0 ? program.id : null,
        members: { create: students.slice(0, i + 1).map((s, k) => ({ studentId: s.id, joinedAt: day(10 + k * 3 - i) })) },
      },
    });
  }

  // --- партнёры ---
  const password = await bcrypt.hash('test12345', 10);
  const partnerData = [
    { fullName: 'Зарина Партнёр', email: 'sort-zarina@e2e.local', code: 'SORTZ', cents: 5000, balance: 120000, earned: 300000, status: 'ACTIVE' as const },
    { fullName: 'Alisher Partner', email: 'sort-alisher@e2e.local', code: 'SORTA', cents: 15000, balance: 0, earned: 50000, status: 'SUSPENDED' as const },
    { fullName: 'Бахром Партнёр', email: 'sort-bahrom@e2e.local', code: 'SORTB', cents: 10000, balance: 45000, earned: 900000, status: 'ACTIVE' as const },
  ];
  const apps = await prisma.application.findMany({ take: 3, orderBy: { createdAt: 'desc' } });
  for (let i = 0; i < partnerData.length; i++) {
    const d = partnerData[i];
    const p = await prisma.partner.create({
      data: {
        email: d.email, password, fullName: d.fullName, referralCode: d.code,
        commissionAmountCents: d.cents, balanceCents: d.balance, totalEarnedCents: d.earned, status: d.status,
      },
    });
    await prisma.commission.createMany({
      data: [
        { partnerId: p.id, amountCents: 5000 + i * 7000, baseAmountCents: 100000 * (3 - i), percent: 0, status: 'PENDING', createdAt: day(5 + i) },
        { partnerId: p.id, amountCents: 20000 - i * 3000, baseAmountCents: 50000 + i * 1000, percent: 10 + i, status: 'PAID', createdAt: day(12 - i) },
      ],
    });
    await prisma.partnerPayout.createMany({
      data: [
        { partnerId: p.id, amountCents: 30000 + i * 10000, method: ['Карта', 'Alif', 'Наличные'][i], details: `Счёт ${i + 1}`, status: 'REQUESTED', requestedAt: day(14 + i) },
        { partnerId: p.id, amountCents: 9000 - i * 1000, method: null, details: null, status: 'PAID', requestedAt: day(3 + i) },
      ],
    });
    await prisma.referralClick.createMany({
      data: [
        { partnerId: p.id, source: 'SITE', ip: `10.0.0.${3 - i}`, referer: 'https://instagram.com', createdAt: day(2 + i) },
        { partnerId: p.id, source: 'BOT', ip: `192.168.1.${i + 1}`, referer: null, createdAt: day(8 + i) },
        { partnerId: p.id, source: 'SITE', ip: null, referer: 'https://google.com', createdAt: day(6 - i) },
      ],
    });
    await prisma.referralAttribution.createMany({
      data: apps.map((a, k) => ({ partnerId: p.id, applicationId: a.id, createdAt: day(4 + k * 2 + i) })),
    });
  }

  // --- зарплата, штрафы, отчёты, посещаемость ---
  const staff = [founder, ...users];
  for (let i = 0; i < staff.length; i++) {
    await prisma.salaryRecord.create({
      data: {
        userId: staff[i].id, periodStart: day(1), periodEnd: day(30), comment: MARK,
        workedMinutes: 9000 - i * 1500, baseAmount: 3000 + i * 500, salesAmount: 40000 - i * 9000,
        bonusAmount: 1600 - i * 300, kpiBonus: i === 1 ? 500 : 0, penalties: i * 100,
        netAmount: 4600 + i * 50, currency: 'TJS', status: i % 2 ? 'PAID' : 'DRAFT',
      },
    });
  }
  const reasons = ['LATE_ARRIVAL', 'CUSTOM', 'ABSENCE'] as const;
  for (let i = 0; i < 3; i++) {
    await prisma.penalty.create({
      data: { userId: founder.id, reason: reasons[i], amount: [50, 200, 100][i], details: MARK, date: day(4 + i * 5), applied: i === 1 },
    });
    await prisma.dailyReport.create({
      data: {
        userId: founder.id, date: day(15 + i), challenges: MARK,
        callsCount: [5, 12, 0][i], meetingsCount: [2, 0, 7][i], applicationsContacted: [9, 3, 4][i],
        salesCount: [1, 3, 0][i], salesAmount: [1500, 700, 0][i],
        activitySummary: ['Звонки по базе', 'Adobe встреча', null][i],
      },
    });
  }
  // Посещаемость: у основателя (его «Рабочий день») и у менеджеров (журнал основателя).
  for (let i = 0; i < staff.length; i++) {
    for (let k = 0; k < 3; k++) {
      const start = new Date(Date.UTC(2026, 8, 15 + k, 3 + ((i + k) % 3), 10 * k, 0)); // 08:00–10:20 Душанбе
      await prisma.timeEntry.create({
        data: {
          userId: staff[i].id, status: 'OFF', clockIn: start, date: start,
          lunchOut: new Date(start.getTime() + 4 * 3600_000),
          lunchIn: new Date(start.getTime() + (4 * 60 + 40 + k * 10) * 60_000),
          clockOut: new Date(start.getTime() + (9 * 60 + k * 25) * 60_000),
          totalMinutes: 480 + k * 25 - i * 5, totalLunchMinutes: 40 + k * 10,
          lateMinutes: ((i + k) % 3) * 15, lateExcuseReason: MARK,
        },
      });
    }
  }

  // --- сделка с этапами оплат ---
  if (students[0]) {
    await prisma.saleSubmission.create({
      data: {
        studentId: students[0].id, programId: program.id, managerId: founder.id, totalAmount: 3000,
        currency: 'USD', notes: MARK,
        paymentStages: {
          create: [
            { order: 1, title: 'Взнос', amount: 1000, dueDate: day(10), status: 'PAID', paidAt: day(9) },
            { order: 2, title: 'Аренда общежития', amount: 1500, dueDate: day(1), status: 'OVERDUE' },
            { order: 3, title: null, amount: 500, dueDate: day(28), status: 'PENDING' },
          ],
        },
      },
    });
  }

  // --- заявки на оплату от студентов (Финансы) ---
  for (let i = 0; i < students.length; i++) {
    await prisma.payment.create({
      data: {
        studentId: students[i].id, amount: [700, 150, 2400][i], currency: 'TJS',
        method: (['CARD', 'CASH', 'BANK_TRANSFER'] as const)[i], status: 'PENDING',
        comment: `${MARK} ${['за июнь', 'аванс', ''][i]}`.trim(), createdAt: day(18 - i * 4),
      },
    });
  }

  // --- окно KPI: студенты, продажи и заявки менеджера «Поиск Менеджер» ---
  const kpiMgr = await prisma.user.findUniqueOrThrow({ where: { email: 'search.mgr@e2e.local' } });
  await prisma.transaction.deleteMany({ where: { comment: MARK } });
  await prisma.student.deleteMany({ where: { comment: MARK } });
  const kpiStudents = [
    { fullName: 'Юсуф СОРТ', direction: Direction.MASTER, amount: 2500 },
    { fullName: 'Amir SORT', direction: Direction.BACHELOR, amount: 900 },
    { fullName: 'Бахор СОРТ', direction: Direction.LANGUAGE, amount: 4100 },
  ];
  for (let i = 0; i < kpiStudents.length; i++) {
    const s = kpiStudents[i];
    const st = await prisma.student.create({
      data: {
        fullName: s.fullName, direction: s.direction, cabinet: 1 + i, comment: MARK,
        managerId: kpiMgr.id, createdAt: new Date(Date.now() - (i + 1) * 86400_000),
      },
    });
    await prisma.transaction.create({
      data: {
        type: 'INCOME', category: i === 1 ? 'ADDITIONAL_FEE' : 'TUITION_PAYMENT', amount: s.amount, currency: 'TJS',
        studentId: st.id, managerId: kpiMgr.id, comment: MARK, date: new Date(Date.now() - (i * 2 + 1) * 86400_000),
      },
    });
  }
  // Продажа в другой валюте — вторая таблица без заголовков в окне KPI.
  await prisma.transaction.create({
    data: {
      type: 'INCOME', category: 'OTHER_INCOME', amount: 300, currency: 'USD', payerName: 'Zafar USD',
      managerId: kpiMgr.id, comment: MARK, date: new Date(Date.now() - 2 * 86400_000),
    },
  });

  // --- звонки команды: у каждого своё число звонков и минут ---
  await prisma.callLog.deleteMany({ where: { notes: MARK } });
  for (let i = 0; i < users.length; i++) {
    for (let k = 0; k <= i; k++) {
      await prisma.callLog.create({
        data: {
          userId: users[i].id, clientName: `Клиент ${i}${k}`, direction: k % 2 ? 'INCOMING' : 'OUTGOING',
          outcome: k === 0 ? 'CONVERTED' : 'ANSWERED', durationSeconds: 60 * (5 - i) + k * 30, notes: MARK,
          occurredAt: new Date(Date.now() - (i * 3 + k + 1) * 3600_000),
        },
      });
    }
  }

  // --- ещё зарплаты основателя (карточка сотрудника) ---
  for (let m = 0; m < 2; m++) {
    await prisma.salaryRecord.create({
      data: {
        userId: founder.id, periodStart: new Date(Date.UTC(2026, 6 + m, 1)), periodEnd: new Date(Date.UTC(2026, 7 + m, 0)),
        comment: MARK, workedMinutes: 7000 + m * 900, baseAmount: 2500 + m * 700, salesAmount: 12000 * (m + 1),
        bonusAmount: 480 + m * 200, kpiBonus: 0, penalties: m ? 0 : 150, netAmount: 2830 + m * 1300, currency: 'TJS',
        status: m ? 'DRAFT' : 'PAID',
      },
    });
  }

  // --- должники (Финансы → задолженность) ---
  const debtApps = await prisma.application.findMany({ where: { status: 'NEW_LEAD' }, take: 3, orderBy: { createdAt: 'asc' } });
  const managersForDebt = [kpiMgr.id, null, users[0]?.id ?? null];
  for (let i = 0; i < debtApps.length; i++) {
    await prisma.application.update({
      where: { id: debtApps[i].id },
      data: { paymentPending: true, programId: i === 1 ? null : program.id, managerId: managersForDebt[i] },
    });
  }

  console.log('OK: данные для проверки сортировки созданы; программа', program.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
