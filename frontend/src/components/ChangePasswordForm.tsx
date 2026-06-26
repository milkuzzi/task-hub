import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { changePassword } from '@/lib/auth-api';
import { ApiError } from '@/lib/api';
import { validateNewPassword } from '@/lib/password';

/**
 * Форма смены собственного пароля (Req 6.1, 6.7).
 *
 * Требует текущий пароль, проверяет длину нового пароля (8–128), его совпадение
 * с подтверждением и несовпадение с текущим. При ошибке backend (например,
 * неверный текущий пароль) показывает локализованное сообщение.
 */
export function ChangePasswordForm(): JSX.Element {
  const { t } = useTranslation();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (current.trim() === '') {
      setError(t('setPassword.errors.currentRequired'));
      return;
    }
    const validation = validateNewPassword(next);
    if (!validation.ok) {
      setError(t('setPassword.errors.length'));
      return;
    }
    if (next === current) {
      setError(t('setPassword.errors.sameAsCurrent'));
      return;
    }
    if (next !== repeat) {
      setError(t('setPassword.errors.mismatch'));
      return;
    }

    setSubmitting(true);
    try {
      await changePassword(current, next);
      setSuccess(true);
      setCurrent('');
      setNext('');
      setRepeat('');
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
          {t('setPassword.changeSuccess')}
        </p>
      )}

      <label className="field">
        <span className="field__label">{t('setPassword.currentPassword')}</span>
        <input
          className="field__input"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          disabled={submitting}
        />
      </label>

      <label className="field">
        <span className="field__label">{t('setPassword.newPassword')}</span>
        <input
          className="field__input"
          type="password"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={submitting}
        />
      </label>

      <label className="field">
        <span className="field__label">{t('setPassword.repeatPassword')}</span>
        <input
          className="field__input"
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          disabled={submitting}
        />
      </label>

      <p className="field__hint">{t('setPassword.hint')}</p>

      <button className="btn btn--primary" type="submit" disabled={submitting}>
        {submitting ? t('common.saving') : t('setPassword.submitChange')}
      </button>
    </form>
  );
}
