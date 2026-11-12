/**
 * Заготовки вместо «Загрузка…» (макет «Загрузка, пусто, ошибка», 11.11.2026):
 * серые блоки той же формы, что и данные, — страница не прыгает, когда данные
 * пришли. Анимация переливания выключается у тех, кто выключил анимации в
 * системе (prefers-reduced-motion, theme.css).
 */

/** Строки таблицы: кружок-аватар, имя с телефоном и несколько колонок. */
export function TableSkeleton({ rows = 8, cols = 4, avatar = true, testId = 'list-skeleton' }: {
  rows?: number;
  cols?: number;
  avatar?: boolean;
  testId?: string;
}) {
  return (
    <div className="sk-table" aria-busy="true" aria-live="polite" data-testid={testId}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="sk-row" key={i}>
          <div className="sk-who">
            {avatar && <span className="sk-circle" />}
            <span className="sk-stack">
              <span className="sk-line" style={{ width: `${120 + ((i * 37) % 70)}px` }} />
              <span className="sk-line is-sm" style={{ width: `${80 + ((i * 23) % 40)}px` }} />
            </span>
          </div>
          {Array.from({ length: cols }, (_, j) => (
            <span key={j} className="sk-cell">
              <span className="sk-line" style={{ width: `${55 + ((i + j * 3) * 17) % 45}%` }} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Сетка карточек (программы, курсы). */
export function CardsSkeleton({ count = 6, testId = 'cards-skeleton' }: { count?: number; testId?: string }) {
  return (
    <div className="sk-cards" aria-busy="true" data-testid={testId}>
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i}>
          <span className="sk-block" />
          <span className="sk-line" style={{ width: '70%' }} />
          <span className="sk-line is-sm" style={{ width: '45%' }} />
          <span className="sk-line is-sm" style={{ width: '60%' }} />
        </div>
      ))}
    </div>
  );
}

/** Карточка записи (клиент, сделка, сотрудник): шапка и поля в две колонки. */
export function DetailSkeleton({ fields = 8, testId = 'detail-skeleton' }: { fields?: number; testId?: string }) {
  return (
    <div className="sk-detail" aria-busy="true" data-testid={testId}>
      <div className="card sk-detail-hero">
        <span className="sk-circle is-lg" />
        <span className="sk-stack">
          <span className="sk-line is-lg" style={{ width: 240 }} />
          <span className="sk-line is-sm" style={{ width: 160 }} />
        </span>
      </div>
      <div className="card sk-detail-body">
        {Array.from({ length: fields }, (_, i) => (
          <span className="sk-field" key={i}>
            <span className="sk-line is-sm" style={{ width: 90 }} />
            <span className="sk-line" style={{ width: `${50 + ((i * 29) % 40)}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}
