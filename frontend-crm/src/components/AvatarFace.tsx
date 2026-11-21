import { absFileUrl } from '../lib/fileUrl';

/**
 * Содержимое кружка сотрудника (21.11.2026): фото, если оно есть, иначе
 * инициалы. Сам кружок (размер, цвет, класс) остаётся у места, где он
 * нарисован, — сюда приходит только «что внутри». Классу кружка с фото
 * добавляется `has-photo` (см. avatarClass): фон убирается, картинка
 * заполняет круг (styles/theme.css → «Фото на аватарке»).
 */
export function AvatarFace({ url, initials }: { url?: string | null; initials: string }) {
  if (url) return <img src={absFileUrl(url)} alt="" loading="lazy" draggable={false} />;
  return <>{initials}</>;
}

/** Класс кружка + `has-photo`, когда фото есть. */
export function avatarClass(base: string, url?: string | null): string {
  return url ? `${base} has-photo` : base;
}
