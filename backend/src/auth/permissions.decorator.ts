import { SetMetadata } from '@nestjs/common';

/** Декоратор, привязывающий конкретные permission-ключи к эндпоинту.
 *  RolesGuard проверяет: если у custom-role-юзера есть ЛЮБОЙ из них —
 *  доступ разрешён. Если эндпоинт также имеет @Roles(...) — это OR
 *  (любая из ролей ИЛИ любой из permissions). */
export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
