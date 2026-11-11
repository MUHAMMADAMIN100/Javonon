import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { normalizePhone } from '../common/phone';

/**
 * Исправление ЯВНЫХ ошибок в старых номерах (QA №21, решение заказчика:
 * «исправить явное, без удалений»):
 *   «+992 992 90 123 45 67» (лишнее «992» в поле номера) → «+992901234567»;
 *   «992901234567» (без «+»)                            → «+992901234567».
 * Неполные номера и дубли не трогаем. updatedAt не меняется (сырой SQL). Каждое
 * исправление — строка в журнале со старым значением. Повторный запуск
 * ничего не находит (правило идемпотентно), поэтому метка «уже сделано»
 * не нужна. Запускается после старта, не задерживая приём запросов.
 */
const DOUBLE_CODE_RE = /^992992(\d{9})$/;
const NO_PLUS_RE = /^992(\d{9})$/;

export function fixTjPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || /[^\d\s()+-]/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  const dbl = DOUBLE_CODE_RE.exec(digits);
  if (dbl) return `+992${dbl[1]}`;
  if (!s.startsWith('+')) {
    const np = NO_PLUS_RE.exec(digits);
    if (np) return `+992${np[1]}`;
  }
  // QA-2: один формат «+<код><номер>» — «+992 555 777 888» → «+992555777888»,
  // «987173998» → «+992987173998». Номер, который не распознаётся (неверная
  // длина), не трогаем: угадывать нельзя, его правят руками.
  const r = normalizePhone(s);
  if ('phone' in r && r.phone !== raw) return r.phone;
  return null;
}

@Injectable()
export class PhoneCleanupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PhoneCleanupService.name);

  constructor(private prisma: PrismaService, private activity: ActivityService) {}

  onApplicationBootstrap() {
    setTimeout(() => {
      this.run().catch((e) => this.logger.warn(`Исправление номеров не выполнено: ${(e as Error).message}`));
    }, 5_000);
  }

  async run(): Promise<{ applications: number; students: number }> {
    let applications = 0;
    let students = 0;
    // Кандидаты отбираем в SQL (только номера, начинающиеся с 992 по цифрам).
    // Кандидаты — номера не в виде «+цифры» (пробелы, скобки, без «+»).
    const apps = await this.prisma.$queryRaw<{ id: string; fullName: string; phone: string; whatsappPhone: string | null; secondaryPhone: string | null }[]>`
      SELECT id, "fullName", phone, "whatsappPhone", "secondaryPhone" FROM "Application"
      WHERE phone !~ '^[+][0-9]+$'
         OR COALESCE("whatsappPhone", '+0') !~ '^[+][0-9]+$'
         OR COALESCE("secondaryPhone", '+0') !~ '^[+][0-9]+$'
         OR regexp_replace(phone, '[^0-9]', '', 'g') ~ '^992992'`;
    for (const a of apps) {
      const phone = fixTjPhone(a.phone);
      const wa = fixTjPhone(a.whatsappPhone);
      const sec = fixTjPhone(a.secondaryPhone);
      if (!phone && !wa && !sec) continue;
      // Сырой SQL, а не prisma.update: тот проставил бы updatedAt, а по нему
      // считаются KPI-окна («закрыто за месяц») — лид «переехал» бы в этот месяц.
      await this.prisma.$executeRaw`
        UPDATE "Application" SET phone = ${phone ?? a.phone}, "whatsappPhone" = ${wa ?? a.whatsappPhone}, "secondaryPhone" = ${sec ?? a.secondaryPhone}
        WHERE id = ${a.id}`;
      applications++;
      const parts = [phone && `${a.phone} → ${phone}`, wa && `WhatsApp ${a.whatsappPhone} → ${wa}`, sec && `второй ${a.secondaryPhone} → ${sec}`].filter(Boolean).join('; ');
      await this.activity
        .log({
          actorId: null,
          actorName: 'Система',
          actorRole: 'SYSTEM',
          action: 'PHONE_FIX',
          studentName: a.fullName,
          details: `Лид: ${a.fullName} — номер исправлен: ${parts}`,
          payload: { entity: 'Application', id: a.id, before: { phone: a.phone, whatsappPhone: a.whatsappPhone } },
        }, null)
        .catch(() => undefined);
    }
    const studs = await this.prisma.$queryRaw<{ id: string; fullName: string; phones: string[] }[]>`
      SELECT id, "fullName", phones FROM "Student"
      WHERE EXISTS (SELECT 1 FROM unnest(phones) p WHERE p !~ '^[+][0-9]+$' OR regexp_replace(p, '[^0-9]', '', 'g') ~ '^992992')`;
    for (const st of studs) {
      const next = st.phones.map((p) => fixTjPhone(p) ?? p);
      if (next.every((p, i) => p === st.phones[i])) continue;
      await this.prisma.$executeRaw`UPDATE "Student" SET phones = ${next} WHERE id = ${st.id}`;
      students++;
      const parts = st.phones.map((p, i) => (p !== next[i] ? `${p} → ${next[i]}` : null)).filter(Boolean).join('; ');
      await this.activity
        .log({
          actorId: null,
          actorName: 'Система',
          actorRole: 'SYSTEM',
          action: 'PHONE_FIX',
          studentId: st.id,
          studentName: st.fullName,
          details: `Студент: ${st.fullName} — номер исправлен: ${parts}`,
          payload: { entity: 'Student', id: st.id, before: { phones: st.phones } },
        }, null)
        .catch(() => undefined);
    }
    if (applications || students) {
      this.logger.log(`Исправлены номера: лидов ${applications}, студентов ${students}`);
    }
    return { applications, students };
  }
}
