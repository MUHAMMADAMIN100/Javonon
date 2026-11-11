import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { gzipSync } from 'zlib';
import { zipSync, strToU8 } from 'fflate';
import { PrismaService } from '../prisma/prisma.service';
import { tjEndOfMonth, tjLocalDay, tjStartOfDay } from '../common/tj-time';
import { monthStartOf, FinanceAccountsService } from './finance-accounts.service';
import { directionOf } from './finance-income.service';
import { groupOf } from './finance-expense.service';
import { logFinance } from './finance-activity';

/**
 * Финансы → Настройки → «Резервные копии и отчёт» (часть 3, 11.11.2026).
 * Решение заказчика: ночные снимки + снимок по кнопке + скачать снимок +
 * отчёт Excel. БЕЗ «Полной очистки» и «Импорта с заменой» — восстановления
 * из интерфейса нет, снимок — файл для сохранности и разбора.
 *
 * Снимок — JSON всех таблиц финансов (gzip) в FinanceBackup.data. Хранится
 * 30 последних ночных и 50 последних ручных.
 */

const KEEP_AUTO = 30;
const KEEP_MANUAL = 50;

const xmlEsc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Минимальный .xlsx: листы со строками; числа — числами, первая строка — жирная. */
function buildXlsx(sheets: Array<{ name: string; rows: unknown[][]; widths?: number[] }>): Uint8Array {
  const sheetXml = (rows: unknown[][], widths?: number[]) => {
    const cols = widths?.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const body = rows
      .map((r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            const st = ri === 0 ? ' s="1"' : '';
            if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
            if (v === null || v === undefined || v === '') return `<c r="${ref}"${st}/>`;
            return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
          })
          .join('')}</row>`,
      )
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
  };
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows, s.widths))));
  return zipSync(files, { level: 6 });
}

@Injectable()
export class FinanceBackupService {
  private readonly logger = new Logger(FinanceBackupService.name);

  constructor(
    private prisma: PrismaService,
    private accounts: FinanceAccountsService,
  ) {}

  async list() {
    const rows = await this.prisma.financeBackup.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, createdAt: true, kind: true, createdByName: true, counts: true, sizeBytes: true },
    });
    return { rows };
  }

  async create(kind: 'AUTO' | 'MANUAL', actorId: string | null) {
    const p = this.prisma;
    const [accounts, transfers, channelMaps, config, subscriptions, debts, otherPlans, payrollMonths, transactions, salaryRecords] = await Promise.all([
      p.financeAccount.findMany(), p.financeTransfer.findMany(), p.financeChannelMap.findMany(), p.financeConfig.findMany(),
      p.financeSubscription.findMany(), p.financeDebt.findMany(), p.financeOtherPlan.findMany(), p.financePayrollMonth.findMany(),
      p.transaction.findMany(), p.salaryRecord.findMany(),
    ]);
    const tables = { accounts, transfers, channelMaps, config, subscriptions, debts, otherPlans, payrollMonths, transactions, salaryRecords };
    const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, (v as unknown[]).length]));
    const json = JSON.stringify({ app: 'javonon-crm', kind: 'finance-backup', version: 1, createdAt: new Date().toISOString(), tables });
    const data = gzipSync(Buffer.from(json, 'utf8'));
    const actor = actorId ? await p.user.findUnique({ where: { id: actorId }, select: { fullName: true } }) : null;
    const row = await p.financeBackup.create({
      data: { kind, createdById: actorId, createdByName: actor?.fullName ?? null, counts, sizeBytes: data.length, data },
      select: { id: true, createdAt: true, kind: true, createdByName: true, counts: true, sizeBytes: true },
    });
    // хранение: последние N своего вида
    const keep = kind === 'AUTO' ? KEEP_AUTO : KEEP_MANUAL;
    const old = await p.financeBackup.findMany({ where: { kind }, orderBy: { createdAt: 'desc' }, skip: keep, select: { id: true } });
    if (old.length) await p.financeBackup.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    await logFinance(p, {
      actorId, action: 'backup.create', entity: 'FinanceBackup', entityId: row.id,
      summary: `${kind === 'AUTO' ? 'ночная' : 'вручную'} · операций: ${counts.transactions}`,
    });
    return row;
  }

  async download(id: string) {
    const b = await this.prisma.financeBackup.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Копия не найдена');
    const stamp = tjLocalDay(b.createdAt);
    return { filename: `javonon-finance-${stamp}-${b.id.slice(0, 6)}.json.gz`, data: Buffer.from(b.data) };
  }

  /** Ночной снимок в 03:00 по Душанбе; второй за сутки не делается. */
  @Cron('0 3 * * *', { timeZone: 'Asia/Dushanbe' })
  async nightly() {
    try {
      const since = tjStartOfDay(new Date());
      const exists = await this.prisma.financeBackup.findFirst({ where: { kind: 'AUTO', createdAt: { gte: since } }, select: { id: true } });
      if (!exists) await this.create('AUTO', null);
    } catch (e) {
      this.logger.error(`Ночная копия финансов не сделана: ${(e as Error).message}`);
    }
  }

  /** Отчёт Excel за месяц: сводка, операции, счета. */
  async report(ym: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const from = monthStartOf(ym);
    const to = tjEndOfMonth(from);
    const txs = await this.prisma.transaction.findMany({
      where: { reversedAt: null, date: { gte: from, lte: to } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      select: {
        date: true, type: true, category: true, amount: true, currency: true, comment: true, productCategoryEnum: true,
        subscriptionId: true, debtId: true, account: { select: { name: true } }, student: { select: { fullName: true } },
        manager: { select: { fullName: true } }, recordedBy: { select: { fullName: true } },
      },
    });
    const DIR = { CONTRACT: 'Контракты', ACADEMY: 'Академия', MASTERCLASS: 'Мастер-классы', OTHER: 'Прочее' } as Record<string, string>;
    const GRP = { salary: 'Зарплата', rent: 'Аренда и подписки', partners: 'Комиссии партнёрам', debts: 'Долги и кредиты', other: 'Прочее' } as Record<string, string>;
    const sum = new Map<string, number>();
    const add = (k: string, v: number) => sum.set(k, Math.round(((sum.get(k) ?? 0) + v) * 100) / 100);
    for (const t of txs) {
      const key = t.type === 'INCOME' ? `in|${DIR[directionOf(t)]}|${t.currency}` : `out|${GRP[groupOf(t)]}|${t.currency}`;
      add(key, t.amount);
    }
    const summary: unknown[][] = [['Раздел', 'Статья', 'Валюта', 'Сумма']];
    const totals: Record<string, number> = {};
    for (const [k, v] of [...sum.entries()].sort()) {
      const [kind, label, cur] = k.split('|');
      summary.push([kind === 'in' ? 'Доход' : 'Расход', label, cur, v]);
      totals[cur] = Math.round(((totals[cur] ?? 0) + (kind === 'in' ? v : -v)) * 100) / 100;
    }
    summary.push([]);
    for (const [cur, v] of Object.entries(totals)) summary.push(['Результат', '', cur, v]);
    const ops: unknown[][] = [['Дата', 'Тип', 'Статья / направление', 'Сумма', 'Валюта', 'Счёт', 'Кто / за что', 'Комментарий', 'Записал']];
    for (const t of txs) {
      ops.push([
        tjLocalDay(t.date), t.type === 'INCOME' ? 'Доход' : 'Расход',
        t.type === 'INCOME' ? DIR[directionOf(t)] : GRP[groupOf(t)],
        t.amount, t.currency, t.account?.name ?? '', t.student?.fullName ?? t.manager?.fullName ?? '', t.comment ?? '', t.recordedBy?.fullName ?? '',
      ]);
    }
    const acc = await this.accounts.listAccounts();
    const accRows: unknown[][] = [['Счёт', 'Валюта', 'Стартовый остаток', 'Остаток сейчас', 'В архиве']];
    for (const a of acc.accounts as any[]) accRows.push([a.name, a.currency, a.startBalance, a.balance, a.archived ? 'да' : '']);
    if (acc.balanceSince) accRows.push([], ['Остатки считаются с', acc.balanceSince]);
    const data = buildXlsx([
      { name: 'Сводка', rows: summary, widths: [12, 26, 9, 16] },
      { name: 'Операции', rows: ops, widths: [12, 9, 22, 14, 8, 18, 26, 40, 22] },
      { name: 'Счета', rows: accRows, widths: [24, 9, 18, 18, 10] },
    ]);
    return { filename: `javonon-finance-${ym}.xlsx`, data: Buffer.from(data) };
  }
}
