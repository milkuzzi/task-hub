import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { requestPasswordReset } from "@/lib/auth-api";
import { ApiError } from "@/lib/api";

/**
 * Публичный экран запроса восстановления пароля.
 *
 * После отправки всегда показывает нейтральное сообщение: пользователь не
 * должен понимать по UI, существует ли введённый email в системе.
 */
export function ForgotPasswordPage(): JSX.Element {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t("errors.generic"));
      }
    } finally {
      setSubmitting(false);
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
          <h1>{t("forgotPassword.heading")}</h1>
          <p className="auth-hint">{t("forgotPassword.description")}</p>
        </div>

        {done ? (
          <>
            <p className="form-success" role="status">
              {t("forgotPassword.success")}
            </p>
            <Link className="btn btn--primary btn--block" to="/login">
              {t("forgotPassword.backToLogin")}
            </Link>
          </>
        ) : (
          <>
            {error !== null && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <label className="field">
              <span className="field__label">{t("forgotPassword.email")}</span>
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

            <button
              className="btn btn--primary btn--block"
              type="submit"
              disabled={submitting}
            >
              {submitting ? t("forgotPassword.submitting") : t("forgotPassword.submit")}
            </button>

            <Link className="auth-link auth-link--center" to="/login">
              {t("forgotPassword.backToLogin")}
            </Link>
          </>
        )}
      </form>
    </section>
  );
}
