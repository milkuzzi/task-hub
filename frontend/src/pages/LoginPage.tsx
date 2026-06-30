import { useState, type FormEvent } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/use-auth";
import { ApiError } from "@/lib/api";

/**
 * Экран входа (Req 5.7, 16.1).
 *
 * Поддерживает два способа: email + пароль и «Войти через MAX» через Бота.
 * При неуспехе по email/паролю выводится единое сообщение об ошибке без
 * указания конкретного поля (Req 5.8); при блокировке — сообщение о временной
 * блокировке (Req 5.10).
 */
export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const { signIn, signInWithMax } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [maxSubmitting, setMaxSubmitting] = useState(false);

  /** Куда вернуться после входа (если попали сюда из защищённого маршрута). */
  const redirectTo =
    (location.state as { from?: string } | null)?.from ?? "/tasks";

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // 401 — неверные учётные данные (без указания поля, Req 5.8);
      // 429/423 — временная блокировка (Req 5.10).
      if (
        err instanceof ApiError &&
        (err.status === 423 || err.status === 429)
      ) {
        setError(t("login.locked"));
      } else if (err instanceof ApiError && err.status === 401) {
        setError(t("login.invalidCredentials"));
      } else {
        setError(t("errors.generic"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMaxLogin(): Promise<void> {
    setError(null);
    setMaxSubmitting(true);
    try {
      await signInWithMax();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error && err.message.trim() !== "") {
        setError(err.message);
      } else {
        setError(t("login.maxFailed"));
      }
    } finally {
      setMaxSubmitting(false);
    }
  }

  return (
    <section className="auth-shell">
      <form className="auth-panel stack" onSubmit={handleSubmit} noValidate>
        <div className="auth-panel__brand">
          <img
            className="auth-logo"
            src="/logo2090.png"
            alt=""
            aria-hidden="true"
            width={40}
            height={40}
          />
          {t("app.title")}
        </div>
        <div className="auth-panel__head">
          <h1>{t("login.heading")}</h1>
        </div>

        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <label className="field">
          <span className="field__label">{t("login.email")}</span>
          <input
            className="field__input"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting || maxSubmitting}
          />
        </label>

        <label className="field">
          <span className="field__label">{t("login.password")}</span>
          <input
            className="field__input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting || maxSubmitting}
          />
        </label>

        <div className="auth-panel__helper">
          <Link className="auth-link auth-link--center" to="/forgot-password">
            {t("login.forgotPassword")}
          </Link>
        </div>

        <button
          className="btn btn--primary btn--block"
          type="submit"
          disabled={submitting || maxSubmitting}
        >
          {submitting ? t("login.submitting") : t("login.submit")}
        </button>

        <div className="auth-divider" aria-hidden="true">
          <span>{t("login.orDivider")}</span>
        </div>

        <button
          className="btn btn--block"
          type="button"
          onClick={handleMaxLogin}
          disabled={submitting || maxSubmitting}
        >
          {maxSubmitting ? t("login.maxWaiting") : t("login.withMax")}
        </button>
      </form>
    </section>
  );
}
