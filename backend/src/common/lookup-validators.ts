import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Ключ значения справочника (статус, направление, страна, источник).
 * Здесь — только форма ключа; есть ли такое значение в справочнике,
 * проверяет сервис через LookupsService.assert() (справочник правится
 * в CRM, декоратор о нём не знает).
 */
export function IsLookupKey(message: string) {
  return applyDecorators(
    IsString({ message }),
    MaxLength(40, { message }),
    Matches(/^[A-Z0-9_]+$/, { message }),
  );
}
