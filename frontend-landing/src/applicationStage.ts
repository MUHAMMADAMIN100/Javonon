import {
  isFinishedApplicationStatus,
  isInProcessingApplicationStatus,
  isNewLeadApplicationStatus,
} from './applicationStatus';

/**
 * Что студент видит в кабинете вместо сырого ApplicationStatus.
 *
 * Зачем модуль. Схема перешла на набор квалификации лида (NEW_LEAD …
 * SUCCESSFUL_LEAD), а шкала в кабинете осталась на старой воронке из шести
 * этапов (NEW → DOCS_REVIEW → … → ENROLLED). Резолв через
 * `Math.max(0, findIndex(...))` молча схлопывал ЛЮБОЙ неизвестный статус в
 * нулевой индекс, поэтому студент на консультации или отсеянный лид одинаково
 * видели «Аризаи нав, 0%». Не падало и не печатало undefined — просто врало.
 * Здесь незнакомое значение — отдельное состояние, а не нулевой шаг.
 *
 * Разделение с applicationStatus.ts. Там — семантические группы, зеркало
 * backend/src/common/application-status.ts (какие значения считать «новым»,
 * «в работе», «успешным», включая легаси-хвосты окна деплоя). Здесь — только
 * вопрос «в какую ступень шкалы это показать студенту». Легаси-списки
 * намеренно не дублируются: ниже переиспользуются предикаты соседнего модуля,
 * и при чистке легаси править надо будет одно место, а не два.
 *
 * Почему ступеней три, а не десять. Десять актуальных статусов — это НЕ
 * воронка, а исходы квалификации лида: «Вне города» не следует за «Онлайн
 * консультацией» и не предшествует ей. Ровно поэтому CRM выпилила свой
 * ApplicationStatusStepper в пользу выпадающего списка (см. комментарий в
 * frontend-crm/src/components/ApplicationStatusSelect.tsx). Но студенту нужен
 * ответ на вопрос «где моя заявка», и три ступени ниже — максимум, который
 * упорядочивается честно: подана → в работе → успех. Разносить «консультацию»
 * и «думает» по отдельным ступеням нельзя: порядка между ними нет, и шкала
 * начала бы выдумывать движение вперёд-назад.
 *
 * Заодно это чинит мёртвые ступени: после переезда на новые статусы в старую
 * шестиступенчатую шкалу не отображалось НИЧЕГО между вторым и последним
 * шагом — DOCS_SUBMITTED, PRE_ADMISSION и AWAITING_PAYMENT стали
 * недостижимыми, и заявка в работе висела на «20%» до самого зачисления.
 */

export type StudentStageKey = 'SUBMITTED' | 'IN_WORK' | 'SUCCESS';

export type StudentStage = {
  key: StudentStageKey;
  /** Крупная подпись текущего состояния в шапке карточки. */
  label: string;
  /** Короткая подпись под точкой шкалы (на мобиле шкала скроллится). */
  short: string;
};

/** Порядок = порядок отрисовки шкалы; индекс = номер шага. */
export const STUDENT_STAGES: StudentStage[] = [
  { key: 'SUBMITTED', label: 'Ариза қабул шуд', short: 'Ариза' },
  { key: 'IN_WORK', label: 'Ариза дар баррасӣ', short: 'Баррасӣ' },
  { key: 'SUCCESS', label: 'Шумо қабул шудед', short: 'Қабул' },
];

/**
 * Статусы, которых нет ни в одной группе applicationStatus.ts, — их шкала
 * обязана разложить сама.
 *
 * Тип — Record по union'у, а не Record<string, …>: это единственное, что не
 * даст лендингу снова разъехаться со схемой. Появится в наборе новый статус —
 * добавь его в union, и tsc потребует решить, куда он идёт, вместо того чтобы
 * молча отрисовать «Аризаи нав, 0%».
 */
type UngroupedApplicationStatus =
  | 'ONLINE_CONSULTATION'
  | 'OFFLINE_CONSULTATION'
  | 'THINKING'
  | 'POTENTIAL_LEAD'
  | 'OUT_OF_TOWN'
  | 'UNDER_17'
  | 'LOW_QUALITY_LEAD';

/**
 * 'internal' — внутренняя оценка лида для менеджера, а не этап.
 * Показывать студенту «вы некачественный лид» нельзя, врать про «идёт
 * обработка» — тоже, поэтому такие заявки уходят в нейтральную карточку
 * без процента и без шкалы.
 */
const UNGROUPED_STAGE: Record<
  UngroupedApplicationStatus,
  StudentStageKey | 'internal'
> = {
  // Менеджер уже работает с заявкой — для студента это одна ступень.
  ONLINE_CONSULTATION: 'IN_WORK',
  OFFLINE_CONSULTATION: 'IN_WORK',
  THINKING: 'IN_WORK',
  POTENTIAL_LEAD: 'IN_WORK',

  // Служебные исходы квалификации — студенту не показываются.
  OUT_OF_TOWN: 'internal',
  UNDER_17: 'internal',
  LOW_QUALITY_LEAD: 'internal',
};

export type StageResolution =
  /** Обычная ступень шкалы; index — валидный индекс в STUDENT_STAGES. */
  | { kind: 'step'; index: number }
  /** Статус есть, но он внутренний — шкалу не рисуем. */
  | { kind: 'internal' }
  /** У студента вообще нет заявки. */
  | { kind: 'none' }
  /** Статус пришёл, но мы его не знаем — честно говорим об этом. */
  | { kind: 'unknown' };

function step(key: StudentStageKey): StageResolution {
  const index = STUDENT_STAGES.findIndex((s) => s.key === key);
  // По построению не -1; проверку оставляем, чтобы рассинхрон ключей выглядел
  // как «не знаем», а не как «ступень первая». Именно молчаливый откат в
  // нулевой индекс и был багом.
  return index < 0 ? { kind: 'unknown' } : { kind: 'step', index };
}

/**
 * Единственная точка, где статус превращается в то, что видит студент.
 *
 * Никогда не возвращает индекс «на всякий случай»: неизвестное значение — это
 * 'unknown', а не нулевая ступень.
 */
export function resolveStudentStage(
  status: string | null | undefined,
): StageResolution {
  if (!status) return { kind: 'none' };
  // Порядок важен: «успешный» проверяем первым, чтобы шкала гарантированно
  // стояла на последней ступени везде, где кабинет уже показал поздравление
  // (тот же предикат, что и в StudentCabinet).
  if (isFinishedApplicationStatus(status)) return step('SUCCESS');
  if (isNewLeadApplicationStatus(status)) return step('SUBMITTED');
  if (isInProcessingApplicationStatus(status)) return step('IN_WORK');

  const ungrouped = UNGROUPED_STAGE[status as UngroupedApplicationStatus];
  if (!ungrouped) return { kind: 'unknown' };
  return ungrouped === 'internal' ? { kind: 'internal' } : step(ungrouped);
}
