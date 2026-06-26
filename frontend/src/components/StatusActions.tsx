import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api';
import { TASK_STATUS_LABEL_KEYS, type TaskStatus } from '@/lib/tasks-api';
import {
  availableStatusActions,
  changeStatus,
  type Actor,
  type StatusAction,
} from '@/lib/status-api';

/**
 * Панель действий смены Статуса Задачи по правилам конечного автомата (Req 10).
 *
 * Отображаются только действия, допустимые из текущего Статуса для роли
 * Пользователя в контексте Задачи (Req 10.4–10.10): расчёт делегирован
 * {@link availableStatusActions}, зеркалящему серверный `StatusMachine`. Сервер
 * остаётся авторитетным: при отказе (`NO_PERMISSION`/`INVALID_TRANSITION`,
 * Req 10.14, 10.15) Статус не меняется, а ошибка показывается Пользователю.
 *
 * Исполнитель не имеет действий смены Статуса (панель не отображается). Время и
 * подписи — на русском (Req 1.1).
 */

interface StatusActionsProps {
  /** Идентификатор Задачи. */
  taskId: string;
  /** Текущий Статус Задачи. */
  status: TaskStatus;
  /** Роль действующего лица в контексте Задачи (`null` — действий нет). */
  actor: Actor | null;
  /** Признак проверки Администратором (Req 10.10). */
  reviewedFlag?: boolean;
  /** Колбэк после успешной смены Статуса (актуальная Задача → новый Статус). */
  onChanged: (status: TaskStatus) => void;
}

/** Ключ перевода подписи действия (без `ADMIN_SET`, у которого свой шаблон). */
const ACTION_LABEL_KEYS = {
  COMPLETE: 'task.statusActions.complete',
  REOPEN: 'task.statusActions.reopen',
  CANCEL: 'task.statusActions.cancel',
  RETURN: 'task.statusActions.return',
  REQUEST_ADMIN: 'task.statusActions.requestAdmin',
  CLEAR_ADMIN: 'task.statusActions.clearAdmin',
} as const;

/** Стабильный ключ действия для React-списка и состояния «в процессе». */
function actionKey(action: StatusAction): string {
  return action.type === 'ADMIN_SET' ? `ADMIN_SET:${action.target}` : action.type;
}

export function StatusActions({
  taskId,
  status,
  actor,
  reviewedFlag = false,
  onChanged,
}: StatusActionsProps): JSX.Element | null {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAdminTarget, setSelectedAdminTarget] = useState<TaskStatus | ''>('');

  const actions = useMemo<StatusAction[]>(() => {
    if (actor === null) {
      return [];
    }
    return availableStatusActions(status, actor, reviewedFlag).filter(
      (action) => !(actor === 'ADMIN' && action.type === 'REQUEST_ADMIN'),
    );
  }, [actor, status, reviewedFlag]);

  const buttonActions = useMemo(
    () => actions.filter((action) => action.type !== 'ADMIN_SET'),
    [actions],
  );

  const adminSetActions = useMemo(
    () =>
      actions.filter(
        (action): action is Extract<StatusAction, { type: 'ADMIN_SET' }> =>
          action.type === 'ADMIN_SET',
      ),
    [actions],
  );
  const hasAdminSelect = adminSetActions.length > 0;

  useEffect(() => {
    setSelectedAdminTarget((current) => {
      if (adminSetActions.some((action) => action.target === current)) {
        return current;
      }
      return adminSetActions[0]?.target ?? '';
    });
  }, [adminSetActions]);

  if (actor === null || actions.length === 0) {
    return null;
  }

  const labelFor = (action: StatusAction): string => {
    if (action.type === 'ADMIN_SET') {
      return t('task.statusActions.adminSet', {
        status: t(TASK_STATUS_LABEL_KEYS[action.target]),
      });
    }
    return t(ACTION_LABEL_KEYS[action.type]);
  };

  const handle = async (action: StatusAction): Promise<void> => {
    setError(null);
    setPending(actionKey(action));
    try {
      const updated = await changeStatus(taskId, action);
      onChanged(updated.status);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('task.statusActions.error'));
    } finally {
      setPending(null);
    }
  };

  const handleAdminSet = async (): Promise<void> => {
    if (selectedAdminTarget === '') {
      return;
    }
    await handle({ type: 'ADMIN_SET', target: selectedAdminTarget });
  };

  return (
    <section className="status-strip" aria-label={t('task.fields.status')}>
      <div
        className={
          hasAdminSelect
            ? 'status-strip__controls status-strip__controls--with-select'
            : 'status-strip__controls'
        }
      >
        {hasAdminSelect && (
          <div className="status-strip__admin-select">
            <select
              className="field__input status-strip__select"
              value={selectedAdminTarget}
              disabled={pending !== null}
              aria-label={t('task.statusActions.adminSelectLabel')}
              onChange={(event) => setSelectedAdminTarget(event.target.value as TaskStatus)}
            >
              <option value="" disabled>
                {t('task.statusActions.adminSelectPlaceholder')}
              </option>
              {adminSetActions.map((action) => (
                <option key={action.target} value={action.target}>
                  {t(TASK_STATUS_LABEL_KEYS[action.target])}
                </option>
              ))}
            </select>
            {(() => {
              const key =
                selectedAdminTarget === ''
                  ? null
                  : actionKey({ type: 'ADMIN_SET', target: selectedAdminTarget });
              return (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={pending !== null || selectedAdminTarget === ''}
                  aria-busy={key !== null && pending === key}
                  onClick={() => void handleAdminSet()}
                >
                  {key !== null && pending === key
                    ? t('common.saving')
                    : t('task.statusActions.adminApply')}
                </button>
              );
            })()}
          </div>
        )}
        {buttonActions.length > 0 && (
          <div className="status-strip__buttons">
            {buttonActions.map((action) => {
              const key = actionKey(action);
              return (
                <button
                  key={key}
                  type="button"
                  className="btn btn--sm"
                  disabled={pending !== null}
                  aria-busy={pending === key}
                  onClick={() => void handle(action)}
                >
                  {pending === key ? t('common.saving') : labelFor(action)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
