/**
 * Презентационный компонент пустого состояния (Req 14).
 *
 * Отображается, когда набор данных пуст. Принимает уже локализованный текст
 * (из `ru.ts`, Req 14.1) и опциональное первичное действие. Компонент не
 * содержит «запасного» текста по умолчанию: если он не отрисован, область
 * остаётся пустой (Req 14.2).
 *
 * Разметка: контейнер `.empty-state` центрирует содержимое по горизонтали
 * (Req 14.5); поясняющий текст использует класс с контрастом ≥4.5:1 (Req 14.3);
 * при наличии действия отображается кнопка `.btn--primary` (Req 14.4).
 */
export interface EmptyStateProps {
  /** Поясняющий текст (из ru.ts). */
  message: string;
  /** Опциональное первичное действие пустого состояния. */
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ message, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <p className="empty-state__message">{message}</p>
      {action && (
        <button
          className="btn btn--primary"
          type="button"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
