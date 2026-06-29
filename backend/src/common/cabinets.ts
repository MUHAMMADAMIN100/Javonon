/**
 * Единый справочник дефолтных кабинетов CRM по направлению (Direction).
 *
 * Используется при автосоздании Student/Application из разных источников
 * (students.service.create, applications.service, submissions.service на
 * approve первого платежа), чтобы студент всегда попадал в правильный
 * кабинет вместо хардкода cabinet=1. FOUNDER может вручную поменять.
 *
 * Должно совпадать с UI-фильтрами/группировкой по кабинетам в CRM.
 */
import { Direction } from '@prisma/client';

export const CABINET_BY_DIRECTION: Record<Direction, number> = {
  BACHELOR: 1,
  MASTER: 2,
  LANGUAGE: 3,
  LANGUAGE_COLLEGE: 4,
  LANGUAGE_BACHELOR: 5,
  COLLEGE: 6,
};

/** Безопасный дефолт, если direction вдруг отсутствует/новый. */
export const DEFAULT_CABINET = 1;
