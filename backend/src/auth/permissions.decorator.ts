import { SetMetadata } from '@nestjs/common';

/**
 * Права роли, нужные для адреса (каталог — auth/permissions.ts). Сотруднику
 * с ролью нужен хотя бы один из ключей — проверяют JwtAuthGuard и
 * RolesGuard. Основателя и сотрудников без роли @Permissions не касается:
 * их ведут @Roles и проверки сервиса, как раньше.
 */
export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
