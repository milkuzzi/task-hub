/**
 * Состояние загрузки (Req 15.1, 15.2).
 *
 * Контейнер с ролью статуса (`role="status"` + `aria-live="polite"`) и непустым
 * видимым текстом, доступным скринридерам одновременно с визуальным индикатором.
 * Спиннер `.spinner` анимируется только вне reduced-motion — это поведение
 * задаётся глобально в `global.css` (Req 15.4) и здесь не управляется.
 *
 * Текст передаётся уже локализованным (из `ru.ts`, по умолчанию `common.loading`).
 */
export interface LoadingStateProps {
  /** Подпись для скринридера и/или видимая (из ru.ts, по умолчанию common.loading). */
  label: string;
}

export function LoadingState({ label }: LoadingStateProps): JSX.Element {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="loading-state__label">{label}</span>
    </div>
  );
}
