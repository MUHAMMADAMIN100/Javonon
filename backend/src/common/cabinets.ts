/**
 * Единый справочник дефолтных кабинетов CRM по направлению (Direction).
 *
 * Используется при автосоздании Student/Application из разных источников
 * (students.service.create, applications.service, submissions.service на
 * approve первого платежа), чтобы студент всегда попадал в правильный
 * кабинет вместо хардкода cabinet=1. FOUNDER может вручную поменять.
 *
 * Должно совпадать с UI-фильтрами/группировкой по кабинетам в CRM.
 *
 * ВАЖНО: применять только к ПОДТВЕРЖДЁННОМУ направлению (directionConfirmed).
 * У заявок с лендинга в direction лежит плейсхолдер DEFAULT_DIRECTION
 * (= BACHELOR), и маппинг превратил бы его в кабинет 1 для 100% лидов —
 * кабинеты 2–6 перестали бы наполняться. Для неподтверждённого направления
 * пишите DEFAULT_CABINET явно (см. ApplicationsService.update).
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

/**
 * Кабинет-«приёмник»: direction отсутствует/новый ИЛИ ещё не подтверждён
 * человеком. Это осознанная заглушка до решения менеджера, а не результат
 * маршрутизации — студенты с directionConfirmed=false помечены как таковые
 * и в CRM показываются как «направление не подтверждено».
 */
export const DEFAULT_CABINET = 1;
