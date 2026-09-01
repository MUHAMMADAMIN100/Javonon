/**
 * СВЕРКА КОМИССИИ (только чтение).
 *
 * Печатает по каждому менеджеру: месячный объём, полосу, ставку и бонус —
 * вызывая НАСТОЯЩИЙ модуль расчёта (common/manager-bonus-volume.ts), а не
 * его копию. Нужен, когда цифра на экране зарплаты вызывает вопрос: если
 * скрипт и экран расходятся — баг в контроллере/фронте, если сходятся —
 * вопрос к данным (даты платежей, валюта сделки, статус одобрения).
 *
 * Запуск:  npx ts-node -T scripts/verify-bonus.ts
 * Месяцы задаются константой MONTHS ниже.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { managerBonusVolume, effectiveManagerBonus } from '../src/common/manager-bonus-volume';
import { computeManagerBonus } from '../src/common/bonus-bands';

const prisma = new PrismaClient();

/** Любая дата внутри интересующего месяца. */
const MONTHS = ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];

async function main() {
  const users = await prisma.user.findMany({
    where: { role: 'SALES_MANAGER' },
    select: { id: true, fullName: true, bonusPercent: true },
    orderBy: { fullName: 'asc' },
  });
  const months = MONTHS;
  const out: any[] = [];
  for (const u of users) {
    for (const m of months) {
      const v = await managerBonusVolume(prisma as any, u.id, new Date(m + 'T00:00:00Z'));
      const eff = effectiveManagerBonus(u.bonusPercent, v.volume);
      const bonus = eff.source === 'PERSONAL'
        ? Math.round((v.volume * eff.percent) / 100 * 100) / 100
        : computeManagerBonus(v.volume).amount;
      if (v.volume === 0) continue;
      out.push({
        менеджер: u.fullName,
        месяц: m.slice(0, 7),
        объём: v.volume,
        полоса: `${eff.band.minAmount}–${eff.band.maxAmount ?? '∞'}`,
        ставка: eff.percent + '%',
        бонус: bonus,
      });
    }
  }
  console.log('=== РАСЧЁТ НАСТОЯЩИМ КОДОМ, ЯКОРЬ paidAt ===');
  console.table(out);
  const total = out.filter((r) => r.менеджер === 'Khurshed Hakimov');
  console.log('Хуршед — сумма объёмов по месяцам:', total.reduce((s, r) => s + r.объём, 0));
  console.log('Хуршед — сумма бонусов по месяцам:', total.reduce((s, r) => s + r.бонус, 0));
}
main().catch((e) => console.error('ОШИБКА:', e.message)).finally(() => prisma.$disconnect());
