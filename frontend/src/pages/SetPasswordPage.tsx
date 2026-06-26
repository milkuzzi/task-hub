import { useState, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { setPassword } from '@/lib/auth-api';
import { ApiError } from '@/lib/api';
import { validateNewPassword } from '@/lib/password';

/**
 * Экран установки пароля по одноразовой ссылке из письма (Req 5.5, 5.6, 6.7).
 *
 * Токен передаётся в query (`?token=...`). Пароль валидируется на длину
 * 8–128 символов и совпадение подтверждения. При истёкшей/использованной
 * ссылке backend возвращает ошибку, которая отображается с предложением
 * запросить новую (Req 5.6).
 */
export function SetPasswordPage(): JSX.Element {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPasswordValue] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (token === null || token.trim() === '') {
    return (
      <section className="auth-shell">
        <div className="auth-panel stack">
          <h1>{t('setPassword.heading')}</h1>
          <p className="form-error" role="alert">
            {t('setPassword.noToken')}
          </p>
        </div>
      </section>
    );
  }

  if (done) {
    return (
      <section className="auth-shell">
        <div className="auth-panel stack">
          <h1>{t('setPassword.heading')}</h1>
          <p className="form-success" role="status">
            {t('setPassword.success')}
          </p>
          <Link className="btn btn--primary btn--block" to="/login">
            {t('setPassword.goToLogin')}
          </Link>
        </div>
      </section>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const validation = validateNewPassword(password);
    if (!validation.ok) {
      setError(t('setPassword.errors.length'));
      return;
    }
    if (password !== repeat) {
      setError(t('setPassword.errors.mismatch'));
      return;
    }

    setSubmitting(true);
    try {
      await setPassword(token as string, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 410 || err.status === 404)) {
        setError(t('setPassword.expired'));
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t('errors.generic'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-shell">
      <form className="auth-panel stack" onSubmit={handleSubmit} noValidate>
        <h1>{t('setPassword.heading')}</h1>

        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <label className="field">
          <span className="field__label">{t('setPassword.newPassword')}</span>
          <input
            className="field__input"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPasswordValue(e.target.value)}
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

        <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
          {submitting ? t('common.saving') : t('setPassword.submitSet')}
        </button>
      </form>
    </section>
  );
}
