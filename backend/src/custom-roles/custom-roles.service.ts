import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isValidPermission, PERMISSION_CATALOG } from '../auth/permissions';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class CustomRolesService {
  constructor(private prisma: PrismaService, private realtime: RealtimeGateway) {}

  catalog() {
    return PERMISSION_CATALOG;
  }

  list() {
    return this.prisma.customRole.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { users: true } } },
    });
  }

  async create(dto: { name: string; description?: string; permissions: string[] }) {
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('Название роли обязательно');
    if (name.length > 50) throw new BadRequestException('Название слишком длинное (макс. 50)');
    if (/[<>]/.test(name)) throw new BadRequestException('Название не должно содержать HTML-теги');
    const description = dto.description ? dto.description.trim().slice(0, 300) : null;
    const perms = sanitizePermissions(dto.permissions);

    const exists = await this.prisma.customRole.findUnique({ where: { name } });
    if (exists) throw new ConflictException('Роль с таким названием уже существует');

    const role = await this.prisma.customRole.create({
      data: { name, description, permissions: perms },
    });
    this.realtime.emitStaff('customRole:new', { id: role.id, name: role.name });
    return role;
  }

  async update(id: string, dto: { name?: string; description?: string; permissions?: string[]; isActive?: boolean }) {
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
    }
    if (dto.isActive !== undefined) {
      data.isActive = !!dto.isActive;
    }
    const updated = await this.prisma.customRole.update({ where: { id }, data });
    this.realtime.emitStaff('customRole:updated', { id });
    return updated;
  }

  async remove(id: string) {
    const role = await this.prisma.customRole.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundException('Роль не найдена');
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
