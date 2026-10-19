import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isValidPermission, migratePermissionsV2, PERMISSION_CATALOG, PERMISSIONS_VERSION } from '../auth/permissions';
import { POSITION_LABEL, POSITION_ROLE_BASES, positionUsersWhere } from '../auth/position-role';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class CustomRolesService implements OnModuleInit {
  private readonly logger = new Logger(CustomRolesService.name);

  constructor(private prisma: PrismaService, private realtime: RealtimeGateway) {}

  /**
   * Разовый перенос ролей на подробный каталог (auth/permissions.ts) —
   * при запуске, до первого запроса. Только роли со старой версией: после
   * переноса версия поднята, и правки основателя сервер больше не трогает.
   * updateMany с условием на версию — два одновременных запуска не
   * перенесут роль дважды.
   *
   * Старые ключи остаются в массиве рядом с новыми: сервер их больше не
   * читает, зато откат на прошлую версию увидит роль прежней, и из базы
   * ничего не пропадает. Уберёт их первое сохранение роли основателем
   * (sanitizePermissions оставляет только пункты каталога).
   */
  async onModuleInit() {
    const old = await this.prisma.customRole.findMany({
      where: { permVersion: { lt: PERMISSIONS_VERSION } },
      select: { id: true, name: true, permissions: true, permVersion: true },
    });
    for (const role of old) {
      const legacy = role.permissions.filter((k) => !isValidPermission(k));
      const next = [...migratePermissionsV2(role.permissions), ...legacy];
      const done = await this.prisma.customRole.updateMany({
        where: { id: role.id, permVersion: role.permVersion },
        data: { permissions: next, permVersion: PERMISSIONS_VERSION },
      });
      if (done.count) {
        this.logger.log(`Роль «${role.name}»: права перенесены на подробный каталог (${role.permissions.length} → ${next.length})`);
      }
    }
  }

  catalog() {
    return PERMISSION_CATALOG;
  }

  /** Роли + сколько сотрудников работает по каждой через должность (positionUsers). */
  async list() {
    const roles = await this.prisma.customRole.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { users: true } } },
    });
    return Promise.all(
      roles.map(async (r) => ({
        ...r,
        positionUsers: r.baseRole ? await this.prisma.user.count({ where: positionUsersWhere(r.baseRole) }) : 0,
      })),
    );
  }

  /**
   * Должность для «Действует на всех с должностью»: null — роль ни к чему не
   * привязана. Только должности менеджеров (auth/position-role.ts), одна роль
   * на должность. exceptId — сама редактируемая роль.
   */
  private async checkBaseRole(raw: unknown, exceptId?: string): Promise<Role | null> {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string' || !(POSITION_ROLE_BASES as string[]).includes(raw)) {
      throw new BadRequestException('Привязать роль можно только к должности менеджера');
    }
    const taken = await this.prisma.customRole.findFirst({
      where: { baseRole: raw as Role, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (taken) {
      throw new ConflictException(`Должность «${POSITION_LABEL[raw]}» уже привязана к роли «${taken.name}»`);
    }
    return raw as Role;
  }

  async create(dto: { name: string; description?: string; permissions: string[]; baseRole?: string | null }) {
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('Название роли обязательно');
    if (name.length > 50) throw new BadRequestException('Название слишком длинное (макс. 50)');
    if (/[<>]/.test(name)) throw new BadRequestException('Название не должно содержать HTML-теги');
    const description = dto.description ? dto.description.trim().slice(0, 300) : null;
    const perms = sanitizePermissions(dto.permissions);

    const exists = await this.prisma.customRole.findUnique({ where: { name } });
    if (exists) throw new ConflictException('Роль с таким названием уже существует');
    const baseRole = await this.checkBaseRole(dto.baseRole);

    const role = await this.prisma.customRole.create({
      data: { name, description, permissions: perms, baseRole, permVersion: PERMISSIONS_VERSION },
    });
    this.realtime.emitStaff('customRole:new', { id: role.id, name: role.name });
    // Роль сразу действует на должность — у этих сотрудников CRM перечитает права.
    if (baseRole) this.realtime.emitStaff('customRole:updated', { id: role.id, baseRoles: [baseRole] });
    return role;
  }

  async update(id: string, dto: { name?: string; description?: string; permissions?: string[]; isActive?: boolean; baseRole?: string | null }) {
    const role = await this.prisma.customRole.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Роль не найдена');

    const data: any = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Название не может быть пустым');
      if (name.length > 50) throw new BadRequestException('Название слишком длинное (макс. 50)');
      if (/[<>]/.test(name)) throw new BadRequestException('Название не должно содержать HTML-теги');
      // Проверяем уникальность только если имя меняется.
      if (name !== role.name) {
        const conflict = await this.prisma.customRole.findUnique({ where: { name } });
        if (conflict) throw new ConflictException('Роль с таким названием уже существует');
      }
      data.name = name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description ? dto.description.trim().slice(0, 300) : null;
    }
    if (dto.permissions !== undefined) {
      data.permissions = sanitizePermissions(dto.permissions);
      data.permVersion = PERMISSIONS_VERSION;
    }
    if (dto.isActive !== undefined) {
      data.isActive = !!dto.isActive;
    }
    if (dto.baseRole !== undefined) {
      data.baseRole = await this.checkBaseRole(dto.baseRole, id);
    }
    const updated = await this.prisma.customRole.update({ where: { id }, data });
    // baseRoles — прежняя и новая должность: у их сотрудников права поменялись,
    // даже если роль им лично не назначена (Layout перечитает /auth/me).
    const baseRoles = [...new Set([role.baseRole, updated.baseRole].filter((r): r is Role => !!r))];
    this.realtime.emitStaff('customRole:updated', { id, baseRoles });
    return updated;
  }

  async remove(id: string) {
    const role = await this.prisma.customRole.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundException('Роль не найдена');
    if (role.baseRole) {
      throw new BadRequestException(
        `Нельзя удалить — роль действует на всех с должностью «${POSITION_LABEL[role.baseRole]}». Сначала уберите должность в роли.`,
      );
    }
    if (role._count.users > 0) {
      throw new BadRequestException(
        `Нельзя удалить — на роли числится ${role._count.users} сотрудник(ов). Сначала переведите их на другую роль.`,
      );
    }
    await this.prisma.customRole.delete({ where: { id } });
    this.realtime.emitStaff('customRole:deleted', { id });
    return { ok: true };
  }
}

function sanitizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    if (!isValidPermission(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }
  return out;
}
