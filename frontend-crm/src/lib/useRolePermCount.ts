import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listPermissionsCatalog, type CustomRole } from '../api/customRoles';
import { useT } from './i18n';

/**
 * Подпись своей роли в списках выбора: «Менеджер по продажам · 20 прав».
 * Считаются только действующие права каталога — старые ключи, которые сервер
 * держит для отката, не учитываются (QA №51/58: в разных местах выходило
 * «60» и «64» для одной роли, а голое «(20)» читали как дубль должности).
 */
export function useRoleOptionLabel(): (r: Pick<CustomRole, 'name' | 'permissions'>) => string {
  const { t } = useT();
  const catalog = useQuery({ queryKey: ['custom-roles', 'catalog'], queryFn: listPermissionsCatalog, staleTime: 10 * 60_000 });
  const keys = useMemo(() => new Set((catalog.data ?? []).map((p) => p.key)), [catalog.data]);
  return (r) => {
    const n = keys.size ? r.permissions.filter((k) => keys.has(k)).length : r.permissions.length;
    return t('roles.optionLabel').replace('{name}', r.name).replace('{n}', String(n));
  };
}
