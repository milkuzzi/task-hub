import { useTranslation } from 'react-i18next';

/**
 * Презентационный компонент состояния ошибки (Req 16).
 *
 * Отображается при сбое загрузки данных или операции. Принимает уже
 * локализованное сообщение (из `ru.ts`, Req 16.1) и опциональный обработчик
 * повтора. Сообщение об ошибке использует класс с контрастом ≥4.5:1 (Req 16.3).
 *
 * Разметка: контейнер `role="alert"` объявляет ошибку для скринридеров;
 * кнопка «Повторить» отображается тогда и только тогда, когда передан
 * обработчик `onRetry` (Req 16.2). Подпись кнопки по умолчанию берётся из
 * ключа `common.retry` словаря `ru.ts` и может быть переопределена через
 * `retryLabel`.
 */
export interface ErrorStateProps {
  /** Сообщение об ошибке (из ru.ts). */
  message: string;
  /** Действие повтора, если операция повторяема (Req 16.2). */
  onRetry?: () => void;
  /** Подпись кнопки повтора (по умолчанию common.retry). */
  retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel }: ErrorStateProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="error-state" role="alert">
      <p className="error-state__message">{message}</p>
      {onRetry && (
        <button className="btn btn--primary" type="button" onClick={onRetry}>
          {retryLabel ?? t('common.retry')}
        </button>
      )}
    </div>
  );
}
