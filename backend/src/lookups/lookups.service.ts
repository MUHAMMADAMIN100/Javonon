import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { LookupItem, LookupKind, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ActivityService } from '../activity/activity.service';
import {
  FLOW_STATUSES,
  KIND_ACCUSATIVE,
  LEGACY_STATUS_LABEL,
  LOOKUP_DEFAULTS,
  LOOKUP_KINDS,
  MACHINE_SOURCES,
} from './lookup-defaults';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const MAX_LABEL = 60;

/** Где лежат ключи каждого вида: [таблица, колонка]. Удаление переносит все. */
const USAGE_COLUMNS: Record<LookupKind, Array<[table: string, column: string]>> = {
  LEAD_STATUS: [['Application', 'status'], ['Application', 'statusBeforeDeal']],
  DIRECTION: [['Application', 'direction'], ['Student', 'direction'], ['Program', 'direction']],
  COUNTRY: [['Application', 'country'], ['Student', 'country']],
  LEAD_SOURCE: [['Application', 'source']],
  STUDENT_STATUS: [['Student', 'status']],
  ONBOARDING_STAGE: [['Student', 'onboardingStage']],
  TASK_STATUS: [['Task', 'status']],
  CONTACT_CHANNEL: [['Application', 'preferredChannel'], ['Student', 'preferredChannel']],
  INTERACTION_TYPE: [['Interaction', 'type']],
  CALL_OUTCOME: [['CallLog', 'outcome']],
  DEAL_PAYMENT_METHOD: [['SubmissionPayment', 'paymentMethod']],
};

export interface LookupInput {
  kind?: LookupKind;
  labelRu?: string;
  labelTg?: string | null;
  color?: string | null;
  showOnSite?: boolean;
  clientLabel?: string | null;
  isClosed?: boolean;
}

interface Actor {
  id: string;
  role?: string;
  fullName?: string;
}

/**
 * Справочники CRM: статусы лидов, направления, страны, источники.
 *
 * Держим их в памяти: таблица крошечная (десятки строк), а читают её на
 * каждой записи лида/студента/программы (проверка значения) и в каждом
 * тексте СМС. Сервер один (Railway), после любой правки кэш перечитывается,
 * а открытые CRM узнают об этом событием lookups:changed.
 */
@Injectable()
export class LookupsService implements OnModuleInit {
  private readonly logger = new Logger(LookupsService.name);
  private cache: LookupItem[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeGateway,
    @Optional() private readonly activity?: ActivityService,
  ) {}

  async onModuleInit() {
    try {
      await this.seedDefaults();
    } catch (e: any) {
      this.logger.error(`Справочники не заполнены: ${e?.message || e}`);
    }
    await this.reload();
  }

  /** Заполнить пустые виды и дозавести системные значения. */
  async seedDefaults() {
    for (const kind of LOOKUP_KINDS) {
      const count = await this.prisma.lookupItem.count({ where: { kind } });
      const defaults = LOOKUP_DEFAULTS[kind];
      const rows = (count === 0 ? defaults : defaults.filter((d) => d.isSystem)).map((d) => ({
        kind,
        key: d.key,
        labelRu: d.labelRu,
        labelTg: d.labelTg,
        color: d.color ?? null,
        isSystem: !!d.isSystem,
        clientLabel: d.clientLabel ?? null,
        isClosed: !!d.isClosed,
        order: defaults.indexOf(d),
      }));
      if (rows.length) await this.prisma.lookupItem.createMany({ data: rows, skipDuplicates: true });
    }
  }

  async reload() {
    this.cache = await this.prisma.lookupItem.findMany({ orderBy: [{ kind: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }] });
  }

  // ─── Чтение (синхронно, из памяти) ───────────────────────────────────

  items(kind: LookupKind): LookupItem[] {
    return this.cache.filter((i) => i.kind === kind);
  }

  get(kind: LookupKind, key: string | null | undefined): LookupItem | undefined {
    if (!key) return undefined;
    return this.cache.find((i) => i.kind === kind && i.key === key);
  }

  has(kind: LookupKind, key: string | null | undefined): boolean {
    return !!this.get(kind, key);
  }

  /** Русская подпись значения (для текстов уведомлений и ошибок). */
  labelRu(kind: LookupKind, key: string | null | undefined): string {
    if (!key) return '—';
    const item = this.get(kind, key);
    if (item) return item.labelRu;
    if (kind === 'LEAD_STATUS' && LEGACY_STATUS_LABEL[key]) return LEGACY_STATUS_LABEL[key];
    return key;
  }

  /** Ключи статусов «лид закрыт» — не в работе (автораспределение их не считает). */
  closedStatusKeys(): string[] {
    return this.items('LEAD_STATUS').filter((i) => i.isClosed).map((i) => i.key);
  }

  /** Ранг статуса в порядке справочника (−1 — нет в справочнике). */
  statusRank(key: string): number {
    return this.items('LEAD_STATUS').findIndex((i) => i.key === key);
  }

  /**
   * Значение из справочника или 400. `field` — подпись поля для ошибки.
   * null/undefined/'' пропускаем: обязательность проверяет DTO.
   */
  assert(kind: LookupKind, value: string | null | undefined, message?: string): void {
    if (value === null || value === undefined || value === '') return;
    if (!this.has(kind, value)) {
      throw new BadRequestException(message || `Выберите ${KIND_ACCUSATIVE[kind]} из списка`);
    }
  }

  /** Источник, который сотрудник может поставить руками (не машинный). */
  isStaffSource(key: string): boolean {
    return this.has('LEAD_SOURCE', key) && !MACHINE_SOURCES.includes(key);
  }

  /**
   * Для сайта: направления и страны (в выпадающие списки — только «показывать
   * на сайте»; подписи нужны всем — у студента или программы может стоять
   * скрытое значение), статусы — как их зовут клиенту.
   */
  publicList() {
    const pick = (kind: LookupKind) =>
      this.items(kind).map((i) => ({ key: i.key, labelTg: i.labelTg, labelRu: i.labelRu, showOnSite: i.showOnSite }));
    return {
      directions: pick('DIRECTION'),
      countries: pick('COUNTRY'),
      statuses: this.items('LEAD_STATUS').map((i) => ({
        key: i.key,
        labelTg: i.labelTg,
        clientLabel: i.clientLabel,
        isClosed: i.isClosed,
      })),
    };
  }

  // ─── Сколько записей ссылаются на значения ───────────────────────────

  async usage(kind: LookupKind): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [table, column] of USAGE_COLUMNS[kind]) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ k: string | null; n: number }>>(
        `SELECT "${column}" AS k, COUNT(*)::int AS n FROM "${table}" WHERE "${column}" IS NOT NULL GROUP BY 1`,
      );
      for (const r of rows) if (r.k) out[r.k] = (out[r.k] || 0) + Number(r.n);
    }
    return out;
  }

  // ─── Правка ───────────────────────────────────────────────────────────

  private clean(v: unknown, field: string, required: boolean): string | null {
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

  private cleanColor(v: unknown): string | null {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !HEX.test(v)) throw new BadRequestException('Цвет — в виде #RRGGBB');
    return v.toUpperCase();
  }

  private assertUniqueLabel(kind: LookupKind, labelRu: string, exceptId?: string) {
    const dup = this.items(kind).find(
      (i) => i.id !== exceptId && i.labelRu.toLocaleLowerCase('ru') === labelRu.toLocaleLowerCase('ru'),
    );
    if (dup) throw new BadRequestException(`«${labelRu}» уже есть в списке`);
  }

  private changed(kind: LookupKind) {
    this.realtime?.emitStaff('lookups:changed', { kind });
  }

  private async log(actor: Actor | undefined, details: string, payload: any) {
    if (!actor || !this.activity) return;
    await this.activity
      .log({ actorId: actor.id, actorRole: actor.role || 'FOUNDER', action: 'LOOKUP_CHANGE', details, payload })
      .catch(() => undefined);
  }

  async create(input: LookupInput, actor?: Actor) {
    const kind = input.kind;
    if (!kind || !LOOKUP_KINDS.includes(kind)) throw new BadRequestException('Неизвестный список');
    const labelRu = this.clean(input.labelRu, 'Название на русском', true)!;
    const labelTg = this.clean(input.labelTg, 'Название на таджикском', false) ?? labelRu;
    this.assertUniqueLabel(kind, labelRu);
    const last = this.items(kind).reduce((m, i) => Math.max(m, i.order), -1);
    const item = await this.prisma.lookupItem.create({
      data: {
        kind,
        key: `X_${randomBytes(5).toString('hex').toUpperCase()}`,
        labelRu,
        labelTg,
        color: this.cleanColor(input.color),
        order: last + 1,
        showOnSite: input.showOnSite ?? true,
        clientLabel: kind === 'LEAD_STATUS' ? this.clean(input.clientLabel, 'Как назвать клиенту', false) : null,
        isClosed: kind === 'LEAD_STATUS' ? !!input.isClosed : false,
      },
    });
    await this.reload();
    this.changed(kind);
    await this.log(actor, `Добавил в «${KIND_TITLE[kind]}»: «${labelRu}»`, { kind, key: item.key });
    return item;
  }

  async update(id: string, input: LookupInput, actor?: Actor) {
    const item = this.cache.find((i) => i.id === id);
    if (!item) throw new NotFoundException('Значение не найдено');
    const data: Prisma.LookupItemUpdateInput = {};
    if (input.labelRu !== undefined) {
      const labelRu = this.clean(input.labelRu, 'Название на русском', true)!;
      this.assertUniqueLabel(item.kind, labelRu, item.id);
      data.labelRu = labelRu;
    }
    if (input.labelTg !== undefined) {
      data.labelTg = this.clean(input.labelTg, 'Название на таджикском', false) ?? (data.labelRu as string) ?? item.labelRu;
    }
    if (input.color !== undefined) data.color = this.cleanColor(input.color);
    if (input.showOnSite !== undefined) data.showOnSite = !!input.showOnSite;
    if (item.kind === 'LEAD_STATUS') {
      if (input.clientLabel !== undefined) data.clientLabel = this.clean(input.clientLabel, 'Как назвать клиенту', false);
      if (input.isClosed !== undefined && !!input.isClosed !== item.isClosed) {
        if (FLOW_STATUSES.includes(item.key)) {
          throw new BadRequestException(`«${item.labelRu}» — системный статус, его нельзя закрыть`);
        }
        data.isClosed = !!input.isClosed;
      }
    }
    const saved = await this.prisma.lookupItem.update({ where: { id }, data });
    await this.reload();
    this.changed(item.kind);
    await this.log(actor, `Изменил в «${KIND_TITLE[item.kind]}»: «${item.labelRu}»${saved.labelRu !== item.labelRu ? ` → «${saved.labelRu}»` : ''}`, {
      kind: item.kind,
      key: item.key,
      before: { labelRu: item.labelRu, labelTg: item.labelTg, color: item.color, showOnSite: item.showOnSite, clientLabel: item.clientLabel, isClosed: item.isClosed },
    });
    return saved;
  }

  async reorder(kind: LookupKind, ids: string[], actor?: Actor) {
    if (!LOOKUP_KINDS.includes(kind)) throw new BadRequestException('Неизвестный список');
    const current = this.items(kind);
    const same = Array.isArray(ids) && ids.length === current.length && current.every((i) => ids.includes(i.id));
    if (!same) throw new BadRequestException('Список изменился — обновите страницу');
    await this.prisma.$transaction(ids.map((id, order) => this.prisma.lookupItem.update({ where: { id }, data: { order } })));
    await this.reload();
    this.changed(kind);
    await this.log(actor, `Изменил порядок в «${KIND_TITLE[kind]}»`, { kind });
    return this.items(kind);
  }

  /**
   * Удалить значение. Если на нём есть записи — только с переносом в другое
   * значение того же списка (moveTo), одной транзакцией: ни одна строка не
   * останется с ключом, которого больше нет.
   */
  async remove(id: string, moveTo: string | undefined, actor?: Actor) {
    const item = this.cache.find((i) => i.id === id);
    if (!item) throw new NotFoundException('Значение не найдено');
    if (item.isSystem) throw new BadRequestException(`«${item.labelRu}» — системное значение, его можно переименовать, но не удалить`);
    const used = (await this.usage(item.kind))[item.key] || 0;
    let target: LookupItem | undefined;
    if (used > 0) {
      if (!moveTo) {
        throw new ConflictException({ message: `«${item.labelRu}» используется в ${used} записях — выберите, куда их перенести`, used });
      }
      target = this.get(item.kind, moveTo);
      if (!target || target.id === item.id) throw new BadRequestException('Выберите, куда перенести записи');
    }
    let moved = 0;
    await this.prisma.$transaction(async (tx) => {
      if (target) {
        for (const [table, column] of USAGE_COLUMNS[item.kind]) {
          moved += await tx.$executeRawUnsafe(
            `UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = $2`,
            target.key,
            item.key,
          );
        }
      }
      await tx.lookupItem.delete({ where: { id } });
    });
    await this.reload();
    this.changed(item.kind);
    await this.log(
      actor,
      `Удалил из «${KIND_TITLE[item.kind]}»: «${item.labelRu}»${target ? `; записи (${moved}) перенесены в «${target.labelRu}»` : ''}`,
      { kind: item.kind, key: item.key, moveTo: target?.key ?? null, moved },
    );
    return { ok: true, moved };
  }
}

/** Названия списков для журнала. */
export const KIND_TITLE: Record<LookupKind, string> = {
  LEAD_STATUS: 'Статусы лидов',
  DIRECTION: 'Направления',
  COUNTRY: 'Страны',
  LEAD_SOURCE: 'Источники',
  STUDENT_STATUS: 'Статусы студента',
  ONBOARDING_STAGE: 'Этапы онбординга',
  TASK_STATUS: 'Статусы задач',
  CONTACT_CHANNEL: 'Каналы связи',
  INTERACTION_TYPE: 'Типы записей истории',
  CALL_OUTCOME: 'Итоги звонков',
  DEAL_PAYMENT_METHOD: 'Способы оплаты',
};
