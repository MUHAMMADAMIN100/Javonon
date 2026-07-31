/**
 * Статусы заявки (ApplicationStatus) для кабинета студента.
 *
 * Зеркалит backend/src/common/application-status.ts и
 * frontend-crm/src/api/types.ts. Держать три копии приходится потому, что
 * лендинг не тянет ни Prisma-клиент, ни пакеты CRM; при правке одного списка
 * правь остальные.
 *
 * Зачем вообще списки, а не сравнение с одним значением. Воронка переехала на
 * набор квалификации лида (NEW_LEAD … SUCCESSFUL_LEAD), но старые значения
 * (NEW, IN_PROGRESS, DOCS_REVIEW, DOCS_SUBMITTED, PRE_ADMISSION,
 * AWAITING_PAYMENT, ENROLLED, COMPLETED) остались в enum'е: Postgres не удаляет
 * значения, на которые ссылаются строки, а `start:prod` делает `prisma db push`
 * без `--accept-data-loss`. Строки переносит prisma/migrate-lead-statuses.ts,
 * и запускается он ТОЛЬКО по явному MIGRATE_LEAD_STATUSES.
 *
 * ⚠️ Раньше здесь было написано, что перенос «отрабатывает уже ПОСЛЕ того, как
 * новый фронт поднялся». Неверно: в `start:prod` он стоит в цепочке `&&` перед
 * `node dist/main`, то есть переписывал бы строки, пока трафик держит
 * предыдущий контейнер бэкенда, — тот про новые значения enum'а не знает и
 * отвечает 500. Из-за этого перенос и сделали опт-ин; подробности в
 * backend/src/common/application-status.ts и DEPLOY.md.
 *
 * Практический вывод для этого файла: до переноса у зачисленного студента
 * лежит ENROLLED, после — SUCCESSFUL_LEAD, и момент перехода назначает
 * человек, а не деплой. Любое чтение «студент зачислен?» обязано принимать оба
 * варианта, иначе поздравление либо не покажется сейчас, либо перестанет
 * показываться после переноса.
 *
 * Легаси-хвосты временные, но снимать их можно только после того, как перенос
 * реально прогнали на КАЖДОМ окружении (проверяется по
 * `SELECT DISTINCT status FROM "Application"`), — не «через какое-то время
 * после деплоя». Тогда же чистим бэкенд и CRM.
 */

/**
 * «Заявка доведена до результата» — успешный лид.
 * SUCCESSFUL_LEAD — актуальное значение, ENROLLED/COMPLETED — легаси-хвост
 * (оба схлопывает migrate-lead-statuses.ts).
 */
export const FINISHED_APPLICATION_STATUSES = [
  'SUCCESSFUL_LEAD',
  'ENROLLED',
  'COMPLETED',
] as const;

const FINISHED_SET = new Set<string>(FINISHED_APPLICATION_STATUSES);

/** Заявка доведена до результата (с учётом легаси-хвоста)? */
export function isFinishedApplicationStatus(status: string | null | undefined): boolean {
  return !!status && FINISHED_SET.has(status);
}

/**
 * Новый, ещё не взятый в работу лид. NEW — легаси-предок NEW_LEAD.
 */
export const NEW_LEAD_APPLICATION_STATUSES = ['NEW_LEAD', 'NEW'] as const;

const NEW_LEAD_SET = new Set<string>(NEW_LEAD_APPLICATION_STATUSES);

/** Заявка ещё в исходном состоянии (с учётом легаси-хвоста)? */
export function isNewLeadApplicationStatus(status: string | null | undefined): boolean {
  return !!status && NEW_LEAD_SET.has(status);
}

/**
 * Заявка в работе. IN_PROCESSING — актуальное значение, остальное —
 * промежуточные этапы старой воронки, которые в него схлопываются.
 */
export const IN_PROCESSING_APPLICATION_STATUSES = [
  'IN_PROCESSING',
  'IN_PROGRESS',
  'DOCS_REVIEW',
  'DOCS_SUBMITTED',
  'PRE_ADMISSION',
  'AWAITING_PAYMENT',
] as const;

const IN_PROCESSING_SET = new Set<string>(IN_PROCESSING_APPLICATION_STATUSES);

/** Заявка взята в работу (с учётом легаси-хвоста)? */
export function isInProcessingApplicationStatus(status: string | null | undefined): boolean {
  return !!status && IN_PROCESSING_SET.has(status);
}
