import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  CrownSimple,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react';
import { useAuth } from '@/lib/use-auth';
import { ApiError } from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { InviteUserForm } from '@/components/InviteUserForm';
import { UserAvatar } from '@/components/UserAvatar';
import { formatMsk } from '@/lib/time';
import {
  deleteUser,
  listDeletedUsers,
  listUsers,
  restoreUser,
  transferAdmin,
  updateUser,
  type AdminUser,
  type DeletedUser,
  type DeleteMode,
} from '@/lib/users-api';

/**
 * Экран администрирования Пользователей (задача 20.3).
 *
 * Доступен только Администратору. Объединяет операции UsersModule:
 * - приглашение нового Пользователя (Req 5.1);
 * - изменение адреса электронной почты и имени (Req 6.2, 6.3);
 * - удаление с подтверждением в режимах soft/hard (Req 8.1, 8.9);
 * - восстановление удалённого Пользователя по сохранённому адресу (Req 7.2);
 * - передача роли администратора (Req 3.1).
 *
 * Опасные операции (удаление, передача роли) требуют подтверждения через
 * модальное окно; отмена не вносит изменений (Req 8.10).
 */
export function AdminUsersPage(): JSX.Element {
  const { t } = useTranslation();
  const { user: current } = useAuth();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [deleted, setDeleted] = useState<DeletedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Состояние диалогов и текущих операций.
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editName, setEditName] = useState('');

  const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>('soft');

  const [transferTarget, setTransferTarget] = useState<AdminUser | null>(null);

  const [restoringUser, setRestoringUser] = useState<DeletedUser | null>(null);
  const [restoreEmail, setRestoreEmail] = useState('');

  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isAdmin = current?.role === 'ADMIN';

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const [active, removed] = await Promise.all([listUsers(), listDeletedUsers()]);
      if (!Array.isArray(active) || !Array.isArray(removed)) {
        throw new TypeError('Некорректный ответ API: ожидались списки пользователей');
      }
      setUsers(active);
      setDeleted(removed);
    } catch (err) {
      setUsers([]);
      setDeleted([]);
      setLoadError(err instanceof ApiError ? err.message : t('errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (isAdmin) {
      void reload();
    } else {
      setLoading(false);
    }
  }, [isAdmin, reload]);

  // Только Администратор имеет доступ к разделу (Req 5.1, 6.2, 6.3, 8.1).
  if (!isAdmin) {
    return (
      <section className="stack page-section">
        <div className="page-head">
          <div className="page-head__content">
            <h1>{t('nav.users')}</h1>
          </div>
        </div>
        <p className="form-error" role="alert">
          {t('errors.forbidden')}
        </p>
      </section>
    );
  }

  function openEdit(user: AdminUser): void {
    setActionError(null);
    setEditing(user);
    setEditEmail(user.email);
    setEditName(user.name);
  }

  function openDelete(user: AdminUser): void {
    setActionError(null);
    setDeleteMode('soft');
    setDeletingUser(user);
  }

  function openRestore(user: DeletedUser): void {
    setActionError(null);
    setRestoreEmail(user.emails[0] ?? '');
    setRestoringUser(user);
  }

  function closeDialogs(): void {
    setEditing(null);
    setDeletingUser(null);
    setTransferTarget(null);
    setRestoringUser(null);
    setActionError(null);
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
      closeDialogs();
      await reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('errors.generic'));
    } finally {
      setActionBusy(false);
    }
  }

  function handleEditConfirm(): void {
    if (editing === null) {
      return;
    }
    const patch: { email?: string; name?: string } = {};
    if (editEmail.trim() !== editing.email) {
      patch.email = editEmail.trim();
    }
    if (editName.trim() !== editing.name) {
      patch.name = editName.trim();
    }
    if (patch.email === undefined && patch.name === undefined) {
      closeDialogs();
      return;
    }
    void runAction(() => updateUser(editing.id, patch).then(() => undefined));
  }

  function handleDeleteConfirm(): void {
    if (deletingUser === null) {
      return;
    }
    void runAction(() => deleteUser(deletingUser.id, deleteMode));
  }

  function handleTransferConfirm(): void {
    if (transferTarget === null) {
      return;
    }
    void runAction(() => transferAdmin(transferTarget.id));
  }

  function handleRestoreConfirm(): void {
    if (restoringUser === null || restoreEmail === '') {
      return;
    }
    void runAction(() => restoreUser(restoringUser.id, restoreEmail).then(() => undefined));
  }

  return (
    <section className="stack page-section">
      <div className="page-head">
        <div className="page-head__content">
          <h1>{t('admin.heading')}</h1>
        </div>
      </div>

      <article className="panel panel--compact stack admin-section">
        <h2>{t('admin.invite.heading')}</h2>
        <InviteUserForm onInvited={() => void reload()} />
      </article>

      <article className="panel panel--compact admin-section">
        <div className="admin-section__head">
          <h2>{t('admin.activeUsers')}</h2>
          <span className="admin-section__count">{users.length}</span>
        </div>
        {loadError !== null && (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        )}
        {loading ? (
          <p>{t('common.loading')}</p>
        ) : users.length === 0 ? (
          <p className="text-muted">{t('common.empty')}</p>
        ) : (
          <div className="admin-directory admin-directory--active">
            <div className="admin-directory__header" aria-hidden="true">
              <span>{t('admin.columns.user')}</span>
              <span>{t('admin.columns.status')}</span>
              <span>{t('admin.columns.actions')}</span>
            </div>
            <ul className="admin-directory__list" aria-label={t('admin.activeUsers')}>
              {users.map((u) => (
                <li className="admin-directory__row" key={u.id}>
                  <div className="admin-directory__identity">
                    <UserAvatar
                      userId={u.id}
                      hasAvatar={u.avatarPath === undefined ? undefined : u.avatarPath !== null}
                      size="md"
                    />
                    <div className="admin-directory__identity-copy">
                      <strong>{u.name}</strong>
                      <span>{u.email}</span>
                    </div>
                  </div>
                  <div className="admin-directory__status">
                    <span
                      className={
                        u.locked
                          ? 'status-badge status-badge--needs_admin'
                          : !u.active
                            ? 'status-badge status-badge--waiting'
                            : 'status-badge status-badge--done'
                      }
                    >
                      {!u.active
                        ? t('admin.status.pending')
                        : u.locked
                          ? t('admin.status.locked')
                          : t('admin.status.active')}
                    </span>
                  </div>
                  <div className="admin-directory__actions">
                    <button
                      className="btn btn--sm"
                      type="button"
                      aria-label={`${t('admin.actions.edit')}: ${u.name}`}
                      title={t('admin.actions.edit')}
                      onClick={() => openEdit(u)}
                    >
                      <PencilSimple size={16} aria-hidden="true" />
                      <span className="admin-directory__action-label">
                        {t('admin.actions.edit')}
                      </span>
                    </button>
                    {u.role !== 'ADMIN' && u.active && (
                      <button
                        className="btn btn--sm"
                        type="button"
                        aria-label={`${t('admin.actions.transferAdmin')}: ${u.name}`}
                        title={t('admin.actions.transferAdmin')}
                        onClick={() => {
                          setActionError(null);
                          setTransferTarget(u);
                        }}
                      >
                        <CrownSimple size={16} aria-hidden="true" />
                        <span className="admin-directory__action-label">
                          {t('admin.actions.transferAdminShort')}
                        </span>
                      </button>
                    )}
                    {u.id !== current?.id && (
                      <button
                        className="btn btn--sm btn--danger"
                        type="button"
                        aria-label={`${t('common.delete')}: ${u.name}`}
                        title={t('common.delete')}
                        onClick={() => openDelete(u)}
                      >
                        <Trash size={16} aria-hidden="true" />
                        <span className="admin-directory__action-label">
                          {t('common.delete')}
                        </span>
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>

      <article className="panel panel--compact admin-section">
        <div className="admin-section__head">
          <h2>{t('admin.deletedUsers')}</h2>
          <span className="admin-section__count">{deleted.length}</span>
        </div>
        {loading ? (
          <p>{t('common.loading')}</p>
        ) : deleted.length === 0 ? (
          <p className="text-muted">{t('admin.noDeleted')}</p>
        ) : (
          <div className="admin-directory admin-directory--deleted">
            <div className="admin-directory__header" aria-hidden="true">
              <span>{t('admin.columns.user')}</span>
              <span>{t('admin.columns.deletedAt')}</span>
              <span>{t('admin.columns.actions')}</span>
            </div>
            <ul className="admin-directory__list" aria-label={t('admin.deletedUsers')}>
              {deleted.map((u) => (
                <li className="admin-directory__row" key={u.id}>
                  <div className="admin-directory__identity">
                    <UserAvatar userId={null} hasAvatar={false} size="md" />
                    <div className="admin-directory__identity-copy">
                      <strong>{u.name}</strong>
                      <span>{u.emails[0] ?? t('admin.restore.noEmails')}</span>
                    </div>
                  </div>
                  <time className="admin-directory__deleted-at" dateTime={u.deletedAt}>
                    {formatMsk(new Date(u.deletedAt))}
                  </time>
                  <div className="admin-directory__actions">
                    <button
                      className="btn btn--sm btn--primary"
                      type="button"
                      disabled={u.emails.length === 0}
                      title={
                        u.emails.length === 0
                          ? t('admin.restore.noEmails')
                          : t('admin.actions.restore')
                      }
                      aria-label={`${t('admin.actions.restore')}: ${u.name}`}
                      onClick={() => openRestore(u)}
                    >
                      <ArrowCounterClockwise size={16} aria-hidden="true" />
                      <span className="admin-directory__action-label">
                        {t('admin.actions.restore')}
                      </span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>

      {/* Изменение email/имени (Req 6.2, 6.3). */}
      <ConfirmDialog
        open={editing !== null}
        title={t('admin.edit.heading')}
        confirmLabel={t('common.save')}
        busy={actionBusy}
        onConfirm={handleEditConfirm}
        onCancel={closeDialogs}
      >
        <div className="stack">
          {actionError !== null && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
          <label className="field">
            <span className="field__label">{t('login.email')}</span>
            <input
              className="field__input"
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              disabled={actionBusy}
            />
          </label>
          <label className="field">
            <span className="field__label">{t('admin.columns.name')}</span>
            <input
              className="field__input"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={actionBusy}
            />
          </label>
        </div>
      </ConfirmDialog>

      {/* Удаление с выбором режима и подтверждением (Req 8.1, 8.9). */}
      <ConfirmDialog
        open={deletingUser !== null}
        title={t('admin.delete.heading')}
        confirmLabel={t('common.delete')}
        danger
        busy={actionBusy}
        onConfirm={handleDeleteConfirm}
        onCancel={closeDialogs}
      >
        <div className="stack">
          {actionError !== null && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
          <p>{t('admin.delete.prompt', { name: deletingUser?.name ?? '' })}</p>
          <label className="field">
            <span className="field__label">{t('admin.delete.mode')}</span>
            <select
              className="field__input"
              value={deleteMode}
              onChange={(e) => setDeleteMode(e.target.value as DeleteMode)}
              disabled={actionBusy}
            >
              <option value="soft">{t('admin.delete.soft')}</option>
              <option value="hard">{t('admin.delete.hard')}</option>
            </select>
          </label>
          <p className="field__hint">
            {deleteMode === 'soft' ? t('admin.delete.softHint') : t('admin.delete.hardHint')}
          </p>
        </div>
      </ConfirmDialog>

      {/* Передача роли администратора с подтверждением (Req 3.1). */}
      <ConfirmDialog
        open={transferTarget !== null}
        title={t('admin.transfer.heading')}
        confirmLabel={t('admin.actions.transferAdmin')}
        danger
        busy={actionBusy}
        onConfirm={handleTransferConfirm}
        onCancel={closeDialogs}
      >
        <div className="stack">
          {actionError !== null && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
          <p>{t('admin.transfer.prompt', { name: transferTarget?.name ?? '' })}</p>
          <p className="field__hint">{t('admin.transfer.hint')}</p>
        </div>
      </ConfirmDialog>

      {/* Восстановление по выбранному сохранённому адресу (Req 7.2, 7.3). */}
      <ConfirmDialog
        open={restoringUser !== null}
        title={t('admin.restore.heading')}
        confirmLabel={t('admin.actions.restore')}
        busy={actionBusy}
        confirmDisabled={restoreEmail === ''}
        onConfirm={handleRestoreConfirm}
        onCancel={closeDialogs}
      >
        <div className="stack">
          {actionError !== null && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
          {restoringUser !== null && restoringUser.emails.length === 0 ? (
            <p className="form-error">{t('admin.restore.noEmails')}</p>
          ) : (
            <label className="field">
              <span className="field__label">{t('admin.restore.chooseEmail')}</span>
              <select
                className="field__input"
                value={restoreEmail}
                onChange={(e) => setRestoreEmail(e.target.value)}
                disabled={actionBusy}
              >
                {restoringUser?.emails.map((mail) => (
                  <option key={mail} value={mail}>
                    {mail}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}
