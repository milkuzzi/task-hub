import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckSquareOffset } from '@phosphor-icons/react';
import { useAuth } from '@/lib/use-auth';
import { ApiError } from '@/lib/api';
import {
  buildMaxOAuthUrl,
  generateOAuthState,
  MAX_OAUTH_STATE_KEY,
} from '@/lib/max-oauth';

/**
 * Экран входа (Req 5.7, 16.1).
 *
 * Поддерживает два способа: email + пароль и «Войти через MAX» (OAuth).
 * При неуспехе по email/паролю выводится единое сообщение об ошибке без
 * указания конкретного поля (Req 5.8); при блокировке — сообщение о временной
 * блокировке (Req 5.10).
 */
export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** Куда вернуться после входа (если попали сюда из защищённого маршрута). */
  const redirectTo =
    (location.state as { from?: string } | null)?.from ?? '/tasks';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // 401 — неверные учётные данные (без указания поля, Req 5.8);
      // 429/423 — временная блокировка (Req 5.10).
      if (err instanceof ApiError && (err.status === 423 || err.status === 429)) {
        setError(t('login.locked'));
      } else if (err instanceof ApiError && err.status === 401) {
        setError(t('login.invalidCredentials'));
      } else {
        setError(t('errors.generic'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleMaxLogin(): void {
    const state = generateOAuthState();
    try {
      sessionStorage.setItem(MAX_OAUTH_STATE_KEY, state);
    } catch {
      // sessionStorage может быть недоступен — переход всё равно выполним.
    }
    window.location.href = buildMaxOAuthUrl('login', state);
  }

  return (
    <section className="auth-shell">
      <form className="auth-panel stack" onSubmit={handleSubmit} noValidate>
        <div className="auth-panel__brand">
          <CheckSquareOffset size={22} weight="duotone" aria-hidden="true" />
          {t('app.title')}
        </div>
        <div className="auth-panel__head">
          <h1>{t('login.heading')}</h1>
        </div>

        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <label className="field">
          <span className="field__label">{t('login.email')}</span>
          <input
            className="field__input"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span className="field__label">{t('login.password')}</span>
          <input
            className="field__input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
          {submitting ? t('login.submitting') : t('login.submit')}
        </button>

        <div className="auth-divider" aria-hidden="true">
          <span>{t('login.orDivider')}</span>
        </div>

        <button
          className="btn btn--block"
          type="button"
          onClick={handleMaxLogin}
          disabled={submitting}
        >
          {t('login.withMax')}
        </button>

        <p className="auth-hint">
          <Link to="/tasks">{t('notFound.home')}</Link>
        </p>
      </form>
    </section>
  );
}
