import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api';
import { inviteUser, type AdminUser } from '@/lib/users-api';

/**
 * Форма приглашения нового Пользователя по имени и адресу электронной почты (Req 5.1).
 *
 * Только Администратор может регистрировать Пользователей (Req 5.1, 5.2); экран
 * администрирования доступен лишь администратору. После успешного приглашения
 * backend отправляет письмо со ссылкой установки пароля (Req 5.3), а форма
 * сообщает об успехе и передаёт созданного Пользователя в список (`onInvited`).
 *
 * Клиентская валидация ограничена базовой проверкой формата и длины (6–254,
 * Req 4.1); окончательную валидацию и отправку письма выполняет backend.
 */
export interface InviteUserFormProps {
  onInvited: (user: AdminUser) => void;
}

/** Базовая проверка формата email на клиенте (окончательная — на backend). */
function isEmailLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 6 && trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function InviteUserForm({ onInvited }: InviteUserFormProps): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (name.trim().length === 0 || name.trim().length > 200) {
      setError(t('admin.invite.errors.name'));
      return;
    }

    if (!isEmailLike(email)) {
      setError(t('admin.invite.errors.email'));
      return;
    }

    setSubmitting(true);
    try {
      const user = await inviteUser({ email: email.trim(), name: name.trim() });
      setSuccess(true);
      setName('');
      setEmail('');
      onInvited(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="stack" onSubmit={handleSubmit} noValidate>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="form-success" role="status">
          {t('admin.invite.success')}
        </p>
      )}

      <label className="field">
        <span className="field__label">{t('admin.columns.name')}</span>
        <input
          className="field__input"
          type="text"
          autoComplete="off"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
        />
      </label>

      <label className="field">
        <span className="field__label">{t('login.email')}</span>
        <input
          className="field__input"
          type="email"
          autoComplete="off"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />
      </label>

      <p className="field__hint">{t('admin.invite.hint')}</p>

      <button className="btn btn--primary" type="submit" disabled={submitting}>
        {submitting ? t('common.saving') : t('admin.invite.submit')}
      </button>
    </form>
  );
}
