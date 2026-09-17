/**
 * API-ПРОВЕРКА массового назначения менеджера лидам: валидация тела,
 * атомарность пачки, одно сводное уведомление, запись журнала по каждому
 * лиду, подтверждение переназначения (409), зеркалирование на студента,
 * права рядового сотрудника и регрессия одиночного назначения.
 *
 * В проекте нет jest — это исполняемый чек-лист вместо него. Нужен запущенный
 * backend (localhost:3001) на ЛОКАЛЬНОЙ тестовой базе с фикстурами из
 * scripts/e2e-bulk-assign-fixtures.ts; на любой другой базе скрипт
 * отказывается стартовать, потому что пишет данные.
 *
 * Запуск:  npx ts-node -T scripts/e2e-bulk-assign-api.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL || '';
if (!/@127\.0\.0\.1:5433\/javonon_e2e/.test(url)) {
  console.error('ОТКАЗ: тест пишет данные и работает только с локальной javonon_e2e.');
  process.exit(1);
}

const API = 'http://localhost:3001/api';
const prisma = new PrismaClient();
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(j)}`);
  return j.token || j.accessToken || j.access_token;
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j: any = null;
  try { j = await r.json(); } catch { /* пустое тело */ }
  return { status: r.status, body: j };
}

const bulk = (token: string, body: unknown) => call(token, 'PATCH', '/applications/bulk/manager', body);

async function leadIds(...nums: number[]) {
  const names = nums.map((n) => `Лид ${String(n).padStart(2, '0')}`);
  const rows = await prisma.application.findMany({ where: { fullName: { in: names } }, select: { id: true, fullName: true } });
  return names.map((nm) => rows.find((r) => r.fullName === nm)!.id);
}
async function managerOf(n: number) {
  const a = await prisma.application.findFirst({ where: { fullName: `Лид ${String(n).padStart(2, '0')}` }, select: { managerId: true } });
  return a?.managerId ?? null;
}

async function main() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: '@e2e.local' } }, select: { id: true, email: true } });
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  const A = id('mgr.a@e2e.local');
  const B = id('mgr.b@e2e.local');
  const FIRED = id('mgr.fired@e2e.local');
  const PLAIN = id('plain@e2e.local');

  const founder = await login('founder@javonon.local', 'founder123');
  const plain = await login('plain@e2e.local', 'test12345');
  const staffCount = await prisma.user.count();

  console.log('\n[1] Валидация тела запроса');
  let r = await bulk(founder, { ids: [], managerId: A });
  check('пустой список → 400', r.status === 400, JSON.stringify(r));
  r = await bulk(founder, { ids: [123, null], managerId: A });
  check('не-строки в списке → 400', r.status === 400, JSON.stringify(r));
  r = await bulk(founder, { ids: await leadIds(1) });
  check('нет managerId → 400', r.status === 400, JSON.stringify(r));
  r = await bulk(founder, { ids: await leadIds(1), managerId: '00000000-0000-0000-0000-000000000000' });
  check('несуществующий менеджер → 404', r.status === 404, JSON.stringify(r));
  r = await bulk(founder, { ids: await leadIds(1), managerId: FIRED });
  check('деактивированный менеджер → 400', r.status === 400, JSON.stringify(r));
  r = await bulk(founder, { ids: Array.from({ length: 201 }, (_, i) => `id-${i}`), managerId: A });
  check('больше 200 лидов → 400', r.status === 400, JSON.stringify(r));
  check('после отказов Лид 01 не тронут', (await managerOf(1)) === null);

  console.log('\n[2] Атомарность: один несуществующий id в пачке');
  r = await bulk(founder, { ids: [...(await leadIds(1, 2)), '11111111-1111-1111-1111-111111111111'], managerId: A });
  check('→ 409', r.status === 409, JSON.stringify(r));
  check('Лид 01 и Лид 02 НЕ назначены (всё или ничего)', (await managerOf(1)) === null && (await managerOf(2)) === null);

  console.log('\n[3] Обычное назначение свободных лидов');
  const notifBefore = await prisma.notification.count();
  const logBefore = await prisma.activityLog.count({ where: { action: 'MANAGER_CHANGE' } });
  r = await bulk(founder, { ids: await leadIds(1, 2, 3, 4), managerId: A });
  check('→ 200', r.status === 200, JSON.stringify(r));
  check('changed=4, unchanged=0, reassigned=0', r.body?.changed === 4 && r.body?.unchanged === 0 && r.body?.reassigned === 0, JSON.stringify(r.body));
  check('в ответе 4 обновлённых лида с manager.fullName', r.body?.updated?.length === 4 && r.body.updated.every((u: any) => u.manager?.fullName === 'Тест Менеджер А'));
  check('в базе все 4 у «А»', (await Promise.all([1, 2, 3, 4].map(managerOf))).every((m) => m === A));
  await new Promise((res) => setTimeout(res, 800)); // уведомление и журнал пишутся после ответа
  const notifAfter = await prisma.notification.count();
  check(`ОДНО сводное уведомление на сотрудника (+${staffCount} строк, а не ${staffCount * 4})`, notifAfter - notifBefore === staffCount, `прирост ${notifAfter - notifBefore}`);
  const lastNotif = await prisma.notification.findFirst({ orderBy: { createdAt: 'desc' } });
  check(`текст уведомления: «${lastNotif?.message}»`, lastNotif?.message === 'Назначено 4 лида → Тест Менеджер А' && lastNotif?.type === 'MANAGER_CHANGE');
  check('payload.bulk=true, count=4, 4 id заявок', (lastNotif?.payload as any)?.bulk === true && (lastNotif?.payload as any)?.count === 4 && (lastNotif?.payload as any)?.applicationIds?.length === 4);
  const logAfter = await prisma.activityLog.count({ where: { action: 'MANAGER_CHANGE' } });
  check('журнал действий: запись ПО КАЖДОМУ лиду (+4)', logAfter - logBefore === 4, `прирост ${logAfter - logBefore}`);
  const lastLog = await prisma.activityLog.findFirst({ where: { action: 'MANAGER_CHANGE' }, orderBy: { createdAt: 'desc' } });
  check(`формат записи журнала: «${lastLog?.details}»`, /^Менеджер 🇹🇯: — → Тест Менеджер А \(массовое назначение\)$/.test(lastLog?.details || ''));

  console.log('\n[4] Повтор той же пачки — изменений нет');
  const n1 = await prisma.notification.count();
  r = await bulk(founder, { ids: await leadIds(1, 2, 3, 4), managerId: A });
  check('→ 200, changed=0, unchanged=4', r.status === 200 && r.body?.changed === 0 && r.body?.unchanged === 4, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 500));
  check('нового уведомления нет', (await prisma.notification.count()) === n1);

  console.log('\n[5] Переназначение без подтверждения');
  r = await bulk(founder, { ids: await leadIds(10, 11, 12, 13), managerId: A });
  check('→ 409 с кодом REASSIGN_CONFIRM_REQUIRED', r.status === 409 && r.body?.code === 'REASSIGN_CONFIRM_REQUIRED', JSON.stringify(r.body));
  check('разбивка: «Тест Менеджер Б» — 3, всего 4, к переназначению 3',
    r.body?.conflicts?.length === 1 && r.body.conflicts[0].managerName === 'Тест Менеджер Б' && r.body.conflicts[0].count === 3 && r.body.total === 4 && r.body.reassignCount === 3,
    JSON.stringify(r.body));
  check('ничего не изменилось: Лид 10 свободен, 11–13 у «Б»', (await managerOf(10)) === null && (await managerOf(11)) === B && (await managerOf(13)) === B);

  console.log('\n[6] Переназначение с подтверждением');
  r = await bulk(founder, { ids: await leadIds(10, 11, 12, 13), managerId: A, confirmReassign: true });
  check('→ 200, changed=4, reassigned=3', r.status === 200 && r.body?.changed === 4 && r.body?.reassigned === 3, JSON.stringify(r.body));
  check('в базе все 4 у «А»', (await Promise.all([10, 11, 12, 13].map(managerOf))).every((m) => m === A));
  await new Promise((res) => setTimeout(res, 500));
  const reLog = await prisma.activityLog.findFirst({ where: { action: 'MANAGER_CHANGE', studentName: 'Лид 11' }, orderBy: { createdAt: 'desc' } });
  check(`журнал помнит прежнего менеджера: «${reLog?.details}»`, (reLog?.details || '').includes('Тест Менеджер Б → Тест Менеджер А'));

  console.log('\n[7] Зеркалирование менеджера на студента');
  r = await bulk(founder, { ids: await leadIds(5), managerId: B });
  const st = await prisma.student.findFirst({ where: { fullName: 'Студент-лид 05' }, select: { managerId: true } });
  check('у связанного студента тот же менеджер', r.status === 200 && st?.managerId === B, JSON.stringify({ r: r.status, st }));

  console.log('\n[8] Дубли id в списке');
  const dupId = (await leadIds(6))[0];
  r = await bulk(founder, { ids: [dupId, dupId, dupId], managerId: A });
  check('→ 200, changed=1', r.status === 200 && r.body?.changed === 1, JSON.stringify(r.body));

  console.log('\n[9] Рядовой менеджер (без права раздавать лиды)');
  r = await bulk(plain, { ids: await leadIds(20, 21), managerId: A });
  check('раздать другому → 403', r.status === 403, JSON.stringify(r));
  check('Лид 20/21 не тронуты', (await managerOf(20)) === null && (await managerOf(21)) === null);
  r = await bulk(plain, { ids: await leadIds(20, 14), managerId: PLAIN, confirmReassign: true });
  check('пачка с ЧУЖИМ лидом, даже на себя → 403', r.status === 403, JSON.stringify(r));
  check('Лид 20 не тронут (всё или ничего)', (await managerOf(20)) === null);
  r = await bulk(plain, { ids: await leadIds(20, 21), managerId: PLAIN });
  check('взять свободные лиды себе → 200, changed=2', r.status === 200 && r.body?.changed === 2, JSON.stringify(r.body));

  console.log('\n[10] Регрессия одиночного назначения (правило прав вынесено в общий метод)');
  const [l22] = await leadIds(22);
  r = await call(plain, 'PATCH', `/applications/${l22}/manager`, { managerId: A });
  check('рядовой: свободный лид другому → 403', r.status === 403, JSON.stringify(r));
  r = await call(plain, 'PATCH', `/applications/${l22}/manager`, { managerId: PLAIN });
  check('рядовой: свободный лид себе → 200', r.status === 200, JSON.stringify(r));
  r = await call(plain, 'PATCH', `/applications/${l22}/manager`, { managerId: A });
  check('рядовой: свой лид передать другому → 403', r.status === 403, JSON.stringify(r));
  r = await call(plain, 'PATCH', `/applications/${l22}/manager`, { managerId: null });
  check('рядовой: снять себя → 200', r.status === 200 && r.body?.managerId === null, JSON.stringify(r));
  const [l14] = await leadIds(14);
  r = await call(plain, 'PATCH', `/applications/${l14}/manager`, { managerId: PLAIN });
  check('рядовой: чужой лид → 403', r.status === 403, JSON.stringify(r));
  r = await call(founder, 'PATCH', `/applications/${l22}/manager`, { managerId: B });
  check('учредитель: одиночное назначение → 200', r.status === 200 && r.body?.managerId === B, JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 500));
  const singleLog = await prisma.activityLog.findFirst({ where: { action: 'MANAGER_CHANGE', studentName: 'Лид 22' }, orderBy: { createdAt: 'desc' } });
  check(`формат журнала одиночного пути не изменился: «${singleLog?.details}»`, singleLog?.details === 'Менеджер 🇹🇯: — → Тест Менеджер Б');

  console.log('\n[11] Без токена');
  const anon = await fetch(`${API}/applications/bulk/manager`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['x'], managerId: A }) });
  check('→ 401', anon.status === 401, String(anon.status));

  console.log(`\n==== ИТОГ: пройдено ${pass}, провалено ${fail} ====`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error('ОШИБКА:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
