import Icon from '../Icon';

/**
 * Пустая страница — объяснение и одна-две кнопки, что сделать дальше
 * (макет «Загрузка, пусто, ошибка»). Например: «По этим фильтрам студентов нет
 * · Выбраны «Менеджер…» и «Статус…» · Сбросить фильтры · Новый студент».
 */
export type EmptyAction = { label: string; onClick: () => void; primary?: boolean; icon?: string; testId?: string };

export default function EmptyState({ icon = 'inbox', title, text, actions = [], testId = 'empty-state' }: {
  icon?: string;
  title: string;
  text?: string;
  actions?: EmptyAction[];
  testId?: string;
}) {
  return (
    <div className="empty-state crm-appear" role="status" data-testid={testId}>
      <span className="empty-state-icon" aria-hidden="true"><Icon name={icon} size={28} /></span>
      <div className="empty-state-title">{title}</div>
      {text && <p className="empty-state-text">{text}</p>}
      {actions.length > 0 && (
        <div className="empty-state-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={a.primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={a.onClick}
              data-testid={a.testId}
            >
              {a.icon && <Icon name={a.icon} size={16} />} {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
