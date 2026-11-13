/**
 * Ключи справочников (LookupItem, «Лиды → Настройки», 13.11.2026).
 *
 * До справочника это были enum'ы Prisma. Теперь значение — любой ключ из
 * справочника своего вида, поэтому тип — строка; проверку «есть ли такое
 * значение» делает LookupsService.assert(). Константы ниже — СИСТЕМНЫЕ
 * значения: их нельзя удалить в настройках, и на них держится логика.
 */
export type ApplicationStatus = string;
export type Direction = string;
export type Country = string;
export type ApplicationSource = string;

export const ApplicationStatus = {
  NEW_LEAD: 'NEW_LEAD',
  IN_PROCESSING: 'IN_PROCESSING',
  SUCCESSFUL_LEAD: 'SUCCESSFUL_LEAD',
} as const;

export const Direction = {
  /** Заглушка направления у лида с сайта (directionConfirmed = false). */
  BACHELOR: 'BACHELOR',
} as const;

export const ApplicationSource = {
  LANDING_FORM: 'LANDING_FORM',
  SELF_REGISTRATION: 'SELF_REGISTRATION',
  REFERRAL: 'REFERRAL',
  OTHER: 'OTHER',
} as const;
