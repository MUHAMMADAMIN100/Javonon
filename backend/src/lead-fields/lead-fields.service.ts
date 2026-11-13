import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { LeadField, LeadFieldType, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ActivityService } from '../activity/activity.service';

/** Вариант ответа поля-списка. */
export interface LeadFieldOption {
  key: string;
  labelRu: string;
  labelTg: string;
}

export interface LeadFieldInput {
  labelRu?: string;
  labelTg?: string | null;
  type?: LeadFieldType;
  required?: boolean;
  options?: Array<{ key?: string; labelRu?: string; labelTg?: string | null }>;
}

/** Значения своих полей в строке лида/студента: { [ключ поля]: значение }. */
export type CustomValues = Record<string, string | number | boolean | string[]>;

const TYPES: LeadFieldType[] = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI', 'BOOL'];
const MAX_LABEL = 60;
const MAX_TEXT = 500;
const MAX_OPTIONS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Actor {
  id: string;
  role?: string;
}

/**
 * Свои поля анкеты лида («Лиды → Настройки → Поля анкеты», 13.11.2026).
 *
 * Основатель сам добавляет вопросы («Уровень английского», «Бюджет»…):
 * поле видно в карточке лида и в форме «Новый лид», колонкой и фильтром в
 * «Лидах», в карточке студента (значения переходят при сделке) и в выгрузке.
 * Значения лежат в Application.customFields / Student.customFields (JSON)
 * под ключом поля; ключ не меняется при переименовании.
 */
@Injectable()
export class LeadFieldsService implements OnModuleInit {
  private readonly logger = new Logger(LeadFieldsService.name);
  private cache: LeadField[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeGateway,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async onModuleInit() {
    try {
      await this.reload();
    } catch (e: any) {
      this.logger.error(`Поля анкеты не загружены: ${e?.message || e}`);
    }
  }

  async reload() {
    this.cache = await this.prisma.leadField.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
  }

  list(): LeadField[] {
    return this.cache;
  }

  get(key: string): LeadField | undefined {
    return this.cache.find((f) => f.key === key);
  }

  optionsOf(f: LeadField): LeadFieldOption[] {
    return Array.isArray(f.options) ? (f.options as unknown as LeadFieldOption[]) : [];
  }

  // ─── Значения ────────────────────────────────────────────────────────

  /**
   * Проверить и привести присланные значения. Неизвестный ключ — ошибка
   * (поле удалили, пока форма была открыта). Пустое значение убирает ключ.
   * `requireAll` — обязательные поля должны быть заполнены (форма сотрудника).
   */
  clean(input: unknown, opts: { requireAll: boolean; current?: unknown }): CustomValues {
    const out: CustomValues = { ...(this.asValues(opts.current)) };
    if (input !== undefined && input !== null) {
      if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Поля анкеты: неверный формат');
      for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
        const f = this.get(key);
        if (!f) throw new BadRequestException('Поле анкеты удалено — обновите страницу');
        const v = this.cleanValue(f, raw);
        if (v === undefined) delete out[key];
        else out[key] = v;
      }
    }
    // Значения полей, которых больше нет, не тащим дальше.
    for (const key of Object.keys(out)) if (!this.get(key)) delete out[key];
    if (opts.requireAll) {
      const missing = this.cache.filter((f) => f.required && out[f.key] === undefined);
      if (missing.length) throw new BadRequestException(`Заполните поле «${missing[0].labelRu}»`);
    }
    return out;
  }

  asValues(v: unknown): CustomValues {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as CustomValues) : {};
  }

  private cleanValue(f: LeadField, raw: unknown): string | number | boolean | string[] | undefined {
    const name = `«${f.labelRu}»`;
    if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) return undefined;
    switch (f.type) {
      case 'TEXT': {
        if (typeof raw !== 'string') throw new BadRequestException(`${name}: нужен текст`);
        const s = raw.replace(/\s+/g, ' ').trim();
        if (!s) return undefined;
        if (s.length > MAX_TEXT) throw new BadRequestException(`${name}: не длиннее ${MAX_TEXT} символов`);
        if (/[<>]/.test(s)) throw new BadRequestException(`${name}: нельзя использовать знаки < и >`);
        return s;
      }
      case 'NUMBER': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.').replace(/\s/g, ''));
        if (!Number.isFinite(n)) throw new BadRequestException(`${name}: нужно число`);
        if (Math.abs(n) > 1e12) throw new BadRequestException(`${name}: слишком большое число`);
        return n;
      }
      case 'DATE': {
        if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
          throw new BadRequestException(`${name}: нужна дата`);
        }
        return raw;
      }
      case 'BOOL': {
        if (typeof raw !== 'boolean') throw new BadRequestException(`${name}: нужно «Да» или «Нет»`);
        return raw;
      }
      case 'SELECT': {
        if (typeof raw !== 'string' || !this.optionsOf(f).some((o) => o.key === raw)) {
          throw new BadRequestException(`${name}: выберите вариант из списка`);
        }
        return raw;
      }
      case 'MULTI': {
        const arr = Array.isArray(raw) ? raw : [raw];
        const keys = this.optionsOf(f).map((o) => o.key);
        if (!arr.every((x) => typeof x === 'string' && keys.includes(x))) {
          throw new BadRequestException(`${name}: выберите варианты из списка`);
        }
        const uniq = keys.filter((k) => arr.includes(k));
        return uniq.length ? uniq : undefined;
      }
    }
    return undefined;
  }

  /** Условие списка лидов по значению своего поля (?cf_<ключ>=…), или null — не фильтр. */
  whereFor(key: string, value: string): Prisma.ApplicationWhereInput | null {
    const f = this.get(key);
    if (!f || !value) return null;
    if (f.type === 'BOOL') {
      if (value !== 'true' && value !== 'false') return null;
      return { customFields: { path: [key], equals: value === 'true' } };
    }
    if (f.type === 'SELECT') return { customFields: { path: [key], equals: value } };
    if (f.type === 'MULTI') return { customFields: { path: [key], array_contains: [value] } };
    return null;
  }

  // ─── Настройка полей ─────────────────────────────────────────────────

  private label(v: unknown, field: string, required: boolean): string | null {
    if (v === undefined || v === null) {
      if (required) throw new BadRequestException(`Заполните поле «${field}»`);
      return null;
    }
    if (typeof v !== 'string') throw new BadRequestException(`Поле «${field}» должно быть текстом`);
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) {
      if (required) throw new BadRequestException(`Заполните поле «${field}»`);
      return null;
    }
    if (s.length > MAX_LABEL) throw new BadRequestException(`«${field}» — не длиннее ${MAX_LABEL} символов`);
    if (/[<>]/.test(s)) throw new BadRequestException(`«${field}»: нельзя использовать знаки < и >`);
    return s;
  }

  private cleanOptions(raw: LeadFieldInput['options'], prev: LeadFieldOption[]): LeadFieldOption[] {
    if (!Array.isArray(raw)) throw new BadRequestException('Добавьте варианты ответа');
    if (raw.length > MAX_OPTIONS) throw new BadRequestException(`Вариантов — не больше ${MAX_OPTIONS}`);
    const out: LeadFieldOption[] = [];
    for (const o of raw) {
      const labelRu = this.label(o?.labelRu, 'Вариант', false);
      if (!labelRu) continue;
      if (out.some((x) => x.labelRu.toLocaleLowerCase('ru') === labelRu.toLocaleLowerCase('ru'))) {
        throw new BadRequestException(`Вариант «${labelRu}» повторяется`);
      }
      const known = o?.key && prev.find((p) => p.key === o.key);
      out.push({
        key: known ? known.key : `O_${randomBytes(4).toString('hex').toUpperCase()}`,
        labelRu,
        labelTg: this.label(o?.labelTg, 'Вариант по-таджикски', false) ?? labelRu,
      });
    }
    if (out.length < 2) throw new BadRequestException('Нужно хотя бы два варианта ответа');
    return out;
  }

  private assertUnique(labelRu: string, exceptId?: string) {
    if (this.cache.some((f) => f.id !== exceptId && f.labelRu.toLocaleLowerCase('ru') === labelRu.toLocaleLowerCase('ru'))) {
      throw new BadRequestException(`Поле «${labelRu}» уже есть`);
    }
  }

  private changed() {
    this.realtime?.emitStaff('lookups:changed', { kind: 'LEAD_FIELD' });
  }

  private async log(actor: Actor | undefined, details: string, payload: any) {
    if (!actor || !this.activity) return;
    await this.activity
      .log({ actorId: actor.id, actorRole: actor.role || 'FOUNDER', action: 'LOOKUP_CHANGE', details, payload })
      .catch(() => undefined);
  }

  /** Сколько лидов и студентов заполнили каждое поле. */
  async usage(): Promise<Record<string, number>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ k: string; n: number }>>(
      `SELECT k, COUNT(*)::int AS n FROM (
         SELECT jsonb_object_keys("customFields") AS k FROM "Application" WHERE "customFields" IS NOT NULL AND jsonb_typeof("customFields") = 'object'
         UNION ALL
         SELECT jsonb_object_keys("customFields") AS k FROM "Student" WHERE "customFields" IS NOT NULL AND jsonb_typeof("customFields") = 'object'
       ) t GROUP BY k`,
    );
    return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
  }

  async create(input: LeadFieldInput, actor?: Actor) {
    const labelRu = this.label(input.labelRu, 'Название по-русски', true)!;
    const labelTg = this.label(input.labelTg, 'Название по-таджикски', false) ?? labelRu;
    if (!input.type || !TYPES.includes(input.type)) throw new BadRequestException('Выберите тип поля');
    this.assertUnique(labelRu);
    const options = input.type === 'SELECT' || input.type === 'MULTI' ? this.cleanOptions(input.options, []) : null;
    const last = this.cache.reduce((m, f) => Math.max(m, f.order), -1);
    const field = await this.prisma.leadField.create({
      data: {
        key: `F_${randomBytes(5).toString('hex').toUpperCase()}`,
        labelRu,
        labelTg,
        type: input.type,
        required: !!input.required,
        options: options ? (options as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        order: last + 1,
      },
    });
    await this.reload();
    this.changed();
    await this.log(actor, `Добавил поле анкеты «${labelRu}»`, { key: field.key, type: field.type });
    return field;
  }

  async update(id: string, input: LeadFieldInput, actor?: Actor) {
    const f = this.cache.find((x) => x.id === id);
    if (!f) throw new NotFoundException('Поле не найдено');
    if (input.type && input.type !== f.type) {
      throw new BadRequestException('Тип поля менять нельзя — удалите поле и добавьте новое');
    }
    const data: Prisma.LeadFieldUpdateInput = {};
    if (input.labelRu !== undefined) {
      const labelRu = this.label(input.labelRu, 'Название по-русски', true)!;
      this.assertUnique(labelRu, f.id);
      data.labelRu = labelRu;
    }
    if (input.labelTg !== undefined) data.labelTg = this.label(input.labelTg, 'Название по-таджикски', false) ?? (data.labelRu as string) ?? f.labelRu;
    if (input.required !== undefined) data.required = !!input.required;
    let removed: string[] = [];
    if (input.options !== undefined && (f.type === 'SELECT' || f.type === 'MULTI')) {
      const prev = this.optionsOf(f);
      const next = this.cleanOptions(input.options, prev);
      removed = prev.filter((p) => !next.some((n) => n.key === p.key)).map((p) => p.key);
      data.options = next as unknown as Prisma.InputJsonValue;
    }
    const saved = await this.prisma.$transaction(async (tx) => {
      const row = await tx.leadField.update({ where: { id }, data });
      // Убранный вариант снимаем со всех лидов и студентов — висячих ключей не остаётся.
      for (const opt of removed) {
        for (const table of ['Application', 'Student']) {
          if (f.type === 'SELECT') {
            await tx.$executeRawUnsafe(
              `UPDATE "${table}" SET "customFields" = "customFields" - $1 WHERE "customFields" ->> $1 = $2`,
              f.key,
              opt,
            );
          } else {
            await tx.$executeRawUnsafe(
              `UPDATE "${table}" SET "customFields" = jsonb_set("customFields", ARRAY[$1], ("customFields" -> $1) - $2)
               WHERE "customFields" -> $1 ? $2`,
              f.key,
              opt,
            );
            await tx.$executeRawUnsafe(
              `UPDATE "${table}" SET "customFields" = "customFields" - $1 WHERE "customFields" -> $1 = '[]'::jsonb`,
              f.key,
            );
          }
        }
      }
      return row;
    });
    await this.reload();
    this.changed();
    await this.log(actor, `Изменил поле анкеты «${f.labelRu}»${saved.labelRu !== f.labelRu ? ` → «${saved.labelRu}»` : ''}`, {
      key: f.key,
      removedOptions: removed,
    });
    return saved;
  }

  async reorder(ids: string[], actor?: Actor) {
    const same = Array.isArray(ids) && ids.length === this.cache.length && this.cache.every((f) => ids.includes(f.id));
    if (!same) throw new BadRequestException('Список изменился — обновите страницу');
    await this.prisma.$transaction(ids.map((id, order) => this.prisma.leadField.update({ where: { id }, data: { order } })));
    await this.reload();
    this.changed();
    await this.log(actor, 'Изменил порядок полей анкеты', {});
    return this.cache;
  }

  /** Удалить поле вместе с его значениями у лидов и студентов. */
  async remove(id: string, actor?: Actor) {
    const f = this.cache.find((x) => x.id === id);
    if (!f) throw new NotFoundException('Поле не найдено');
    let cleared = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const table of ['Application', 'Student']) {
        cleared += await tx.$executeRawUnsafe(
          `UPDATE "${table}" SET "customFields" = "customFields" - $1 WHERE "customFields" ? $1`,
          f.key,
        );
      }
      await tx.leadField.delete({ where: { id } });
    });
    await this.reload();
    this.changed();
    await this.log(actor, `Удалил поле анкеты «${f.labelRu}» (значений: ${cleared})`, { key: f.key, cleared });
    return { ok: true, cleared };
  }
}
