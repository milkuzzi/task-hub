import { useCallback, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from './useFocusTrap';

/**
 * Модальное окно подтверждения опасных операций.
 *
 * Используется для подтверждения удаления Пользователя (Req 8.9) и передачи
 * роли администратора (Req 3.1). Отмена не вносит изменений в данные (Req 8.10):
 * вызывающий код выполняет действие только в `onConfirm`.
 *
 * Доступность: окно получает фокус при открытии, закрывается по `Esc`, имеет
 * роль `dialog` и `aria-modal`. Подложка перекрывает контент, но при узких
 * экранах (от 320px) окно сжимается без горизонтальной прокрутки (Req 1.5).
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Текст/разметка тела (описание последствий, выбор режима и т.п.). */
  children?: ReactNode;
  /** Подпись кнопки подтверждения (по умолчанию — «Подтвердить»). */
  confirmLabel?: string;
  /** Опасное действие подсвечивает кнопку подтверждения красным. */
  danger?: boolean;
  /** Блокировка кнопок на время выполнения операции. */
  busy?: boolean;
  /** Запрет подтверждения (например, нет выбранного адреса для восстановления). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Захват фокуса, цикл Tab/Shift+Tab, возврат фокуса и закрытие по Escape
  // (Req 11.2–11.5). Escape игнорируется во время выполнения операции (`busy`),
  // сохраняя прежнее поведение.
  const handleEscape = useCallback(() => {
    if (!busy) {
      onCancel();
    }
  }, [busy, onCancel]);

  useFocusTrap({ active: open, containerRef: dialogRef, onEscape: handleEscape });

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) {
          onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal stack"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal__title">{title}</h2>
        {children}
        <div className="modal__actions">
          <button
            className="btn"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button
            className={danger ? 'btn btn--danger' : 'btn btn--primary'}
            type="button"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? t('common.saving') : (confirmLabel ?? t('common.confirm'))}
          </button>
        </div>
      </div>
    </div>
  );
}
