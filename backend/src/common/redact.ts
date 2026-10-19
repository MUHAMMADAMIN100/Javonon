import { hasPermission, isFounder, UserWithRoles } from '../auth/role-utils';

/**
 * Видимость данных для сотрудника с ролью (Настройки → Роли → «Видимость
 * данных»). Без права сервер данные не отдаёт: деньги — null и флаг
 * moneyHidden, телефон и email — с маской. Основатель и сотрудники без роли
 * видят всё, как раньше. Свои деньги и данные сотрудник видит всегда —
 * это решает место вызова (сравнением id).
 */
export type VisibilityKey =
  | 'visibility:client-money'
  | 'visibility:company-money'
  | 'visibility:staff-pay'
  | 'visibility:staff-personal';

export function canSeeData(user: UserWithRoles | null | undefined, key: VisibilityKey): boolean {
  if (!user) return false;
  if (!user.hasCustomRole || isFounder(user)) return true;
  return hasPermission(user, key);
}

/** Поля сумм в ответах о деньгах клиентов: сделки, платежи, этапы, оплаты студента. */
const MONEY_KEYS = new Set([
  'amount', 'amountTjs', 'originalAmount', 'nextDueAmount', 'totalAmount', 'actualAmount',
  'paid', 'paidAmount', 'outstanding', 'overdueAmount', 'stagesTotal', 'amountDrift',
  'totalPaid', 'paidTotal',
]);
/** Чеки и подтверждения оплаты — тоже деньги клиента. */
const RECEIPT_KEYS = new Set(['receiptUrls', 'depositProofUrls', 'receiptUrl']);
/** Суммы по валютам: { USD: 100 }. */
const MONEY_MAP_KEYS = new Set(['totalPaidOther', 'nonTjsTotals']);

/**
 * Глубокая копия ответа без сумм и чеков: суммы → null, списки чеков → [],
 * у корня — moneyHidden: true (CRM рисует «•••• TJS»). Даты и прочие поля
 * не трогаются.
 */
export function hideMoney<T>(value: T): T {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object' || v instanceof Date) return v;
    const out: any = {};
    for (const [k, x] of Object.entries(v)) {
      if (MONEY_KEYS.has(k) && (typeof x === 'number' || x === null)) out[k] = null;
      else if (RECEIPT_KEYS.has(k)) out[k] = Array.isArray(x) ? [] : null;
      else if (MONEY_MAP_KEYS.has(k)) out[k] = {};
      else out[k] = walk(x);
    }
    return out;
  };
  const res = walk(value);
  if (res && typeof res === 'object' && !Array.isArray(res)) res.moneyHidden = true;
  return res;
}

/** То же для списка: у каждого элемента moneyHidden. */
export function hideMoneyList<T>(list: T[]): T[] {
  return list.map((x) => hideMoney(x));
}

/** «+992 93 123 45 67» → «+992 •• ••• •• 67»: код страны и две последние цифры. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return phone ?? null;
  const total = (phone.match(/\d/g) || []).length;
  if (total <= 2) return phone.replace(/\d/g, '•');
  const keepHead = phone.trim().startsWith('+') ? Math.min(3, total - 2) : 0;
  let seen = 0;
  return phone.replace(/\d/g, (d) => {
    seen += 1;
    return seen <= keepHead || seen > total - 2 ? d : '•';
  });
}

/**
 * Email сотрудника в записях (row.user.email) — с маской, если роли не
 * видны «Личные данные сотрудников». Табель, опоздания.
 */
export function maskStaffEmails<T extends { user?: { email?: string | null } | null }>(
  me: UserWithRoles | null | undefined,
  rows: T[],
): T[] {
  if (canSeeData(me, 'visibility:staff-personal')) return rows;
  return rows.map((r) => (r.user ? { ...r, user: { ...r.user, email: maskEmail(r.user.email) } } : r));
}

/** «alice@gmail.com» → «a••••@gmail.com». */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return email ?? null;
  const at = email.indexOf('@');
  if (at <= 0) return '••••';
  return `${email[0]}••••${email.slice(at)}`;
}
