/**
 * Регрессионный тест сетки комиссии менеджера:
 *   common/bonus-bands.ts          — выбор полосы и расчёт бонуса,
 *   common/manager-bonus-volume.ts — действующая ставка (effectiveManagerBonus).
 *
 * Запуск:  npm run test:bonus-bands
 *
 * Почему не jest: в backend нет тест-раннера, а добавлять зависимость
 * ради одного файла запрещено ограничениями задачи. Здесь хватает
 * встроенного node:assert + ts-node, который и так есть в dependencies
 * (им же гоняются prisma/seed*.ts). Скрипт лежит вне src и исключён из
 * tsconfig, чтобы не попадать в `nest build` (rootDir = ./src).
 *
 * Главный случай — FLOAT-BAND-FIX: сумма Float-платежей, десятично
 * равная ровно 150 000.00, но как Float чуть больше порога. До фикса
 * объём проваливался в полосу 150 001–225 000 (6%) и давал 9 000
 * вместо 7 500 — односторонняя переплата ровно на граничном примере
 * из ТЗ. Тот же класс ошибки на 75 000 / 225 000 / 300 000.
 */
import { strict as assert } from 'assert';
import {
  MANAGER_BONUS_BANDS,
  computeManagerBonus,
  findManagerBonusBand,
} from '../src/common/bonus-bands';
import { effectiveManagerBonus } from '../src/common/manager-bonus-volume';

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Как копится объём в salary.service: reduce по Float-платежам. */
const sumPayments = (payments: number[]): number =>
  payments.reduce((s, p) => s + p, 0);

console.log('bonus-bands: сетка комиссии менеджера');

test('РЕГРЕССИЯ: 7 платежей на ровно 150 000.00 → полоса 5%, бонус 7 500', () => {
  const payments = [6948.28, 21080.81, 4960.17, 14775.2, 3445.05, 37396.48, 61394.01];
  const raw = sumPayments(payments);

  // Предпосылка теста: сырая Float-сумма действительно перелетает порог.
  // Если это перестанет быть правдой, тест потеряет смысл — падаем.
  assert.ok(
    raw > 150_000,
    `предпосылка сломалась: сырая сумма ${raw} уже не превышает 150 000`,
  );
  assert.equal(Math.round(raw * 100) / 100, 150_000, 'десятично сумма должна быть ровно 150 000.00');

  assert.equal(findManagerBonusBand(raw).key, 'band2', 'полоса должна быть 75 001–150 000 (5%)');
  const bonus = computeManagerBonus(raw);
  assert.equal(bonus.percent, 5);
  assert.equal(bonus.amount, 7_500, 'бонус 7 500, а не 9 000');
});

test('верхние границы полос включительны: 75 000 / 150 000 / 225 000 / 300 000', () => {
  const expected: [number, string, number][] = [
    [75_000, 'band1', 4],
    [150_000, 'band2', 5],
    [225_000, 'band3', 6],
    [300_000, 'band4', 7],
  ];
  for (const [volume, key, percent] of expected) {
    assert.equal(findManagerBonusBand(volume).key, key, `${volume} → ${key}`);
    assert.equal(computeManagerBonus(volume).percent, percent, `${volume} → ${percent}%`);
  }
});

test('порог + 1 уходит в следующую полосу', () => {
  const expected: [number, string][] = [
    [75_001, 'band2'],
    [150_001, 'band3'],
    [225_001, 'band4'],
    [300_001, 'band5'],
  ];
  for (const [volume, key] of expected) {
    assert.equal(findManagerBonusBand(volume).key, key, `${volume} → ${key}`);
  }
});

test('float-перелёт на каждом пороге не поднимает полосу', () => {
  for (const threshold of [75_000, 150_000, 225_000, 300_000]) {
    const overshoot = threshold + 1e-9; // < половины копейки → округляется вниз
    const band = findManagerBonusBand(threshold);
    assert.equal(
      findManagerBonusBand(overshoot).key,
      band.key,
      `${threshold}+1e-9 должно остаться в полосе ${band.key}`,
    );
  }
});

test('настоящее превышение на копейку полосу поднимает', () => {
  // 150 000.01 — это уже не 150 000, округление не должно это «съесть».
  assert.equal(findManagerBonusBand(150_000.01).key, 'band3');
  assert.equal(findManagerBonusBand(75_000.5).key, 'band2');
});

test('flat на весь объём, не по срезам', () => {
  // 200 000 → 6% от ВСЕГО объёма = 12 000 (прогрессивно вышло бы 9 750).
  assert.equal(computeManagerBonus(200_000).amount, 12_000);
});

test('мусорный вход → 0, первая полоса, бонус 0', () => {
  for (const v of [NaN, Infinity, -Infinity, -1, 0]) {
    assert.equal(findManagerBonusBand(v).key, 'band1', `${v} → band1`);
    assert.equal(computeManagerBonus(v).amount, 0, `${v} → бонус 0`);
  }
});

test('полосы стыкуются без зазоров и без нахлёста', () => {
  for (let i = 1; i < MANAGER_BONUS_BANDS.length; i++) {
    const prev = MANAGER_BONUS_BANDS[i - 1];
    const cur = MANAGER_BONUS_BANDS[i];
    assert.notEqual(prev.maxAmount, null, `у полосы ${prev.key} должен быть потолок`);
    assert.equal(prev.maxAmount! + 1, cur.minAmount, `${prev.key} → ${cur.key} стык`);
  }
  assert.equal(
    MANAGER_BONUS_BANDS[MANAGER_BONUS_BANDS.length - 1].maxAmount,
    null,
    'последняя полоса без потолка',
  );
});

test('случайные десятично-точные разбиения 150 000.00 остаются на 5%', () => {
  // Тот же класс входа, что нашёл аудит, но без привязки к одной семёрке
  // сумм: набираем случайные копеечные части, последняя закрывает остаток.
  for (let iter = 0; iter < 2000; iter++) {
    const parts: number[] = [];
    let leftCents = 150_000 * 100;
    const n = 3 + (iter % 8);
    for (let i = 0; i < n - 1; i++) {
      const takeCents = 1 + Math.floor(Math.random() * (leftCents - (n - 1 - i)));
      leftCents -= takeCents;
      parts.push(takeCents / 100);
    }
    parts.push(leftCents / 100);
    const raw = sumPayments(parts);
    assert.equal(
      findManagerBonusBand(raw).key,
      'band2',
      `разбиение ${JSON.stringify(parts)} дало сумму ${raw} и полосу ${findManagerBonusBand(raw).key}`,
    );
    assert.equal(computeManagerBonus(raw).amount, 7_500);
  }
});

test('effectiveManagerBonus: сетка на границе 150 000 → 5%, а не 6%', () => {
  const payments = [6948.28, 21080.81, 4960.17, 14775.2, 3445.05, 37396.48, 61394.01];
  // Ровно то, что теперь делает managerBonusVolume перед возвратом.
  const raw = sumPayments(payments);
  const volume = Math.round(raw * 100) / 100;
  const eff = effectiveManagerBonus(0, volume);
  assert.equal(eff.source, 'BAND');
  assert.equal(eff.percent, 5);
  assert.equal(eff.band.key, 'band2');
  // И даже если объём придёт неокруглённым — защита в bonus-bands держит.
  assert.equal(effectiveManagerBonus(0, raw).percent, 5);
});

test('effectiveManagerBonus: персональный процент перебивает сетку, полоса всё равно есть', () => {
  const eff = effectiveManagerBonus(9, 150_000);
  assert.equal(eff.source, 'PERSONAL');
  assert.equal(eff.percent, 9);
  assert.equal(eff.personalPercent, 9);
  assert.equal(eff.band.key, 'band2', 'полоса считается даже при личной ставке');
});

test('effectiveManagerBonus: 0 / null / undefined = «по сетке»', () => {
  for (const p of [0, null, undefined]) {
    const eff = effectiveManagerBonus(p, 150_000);
    assert.equal(eff.source, 'BAND', String(p));
    assert.equal(eff.percent, 5, String(p));
  }
});
if (failed > 0) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\nвсе проверки прошли');
