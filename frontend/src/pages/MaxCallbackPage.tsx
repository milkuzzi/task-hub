import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/use-auth";
import { linkMax } from "@/lib/auth-api";
import {
  MAX_OAUTH_STATE_KEY,
  maxCallbackPath,
  type MaxOAuthPurpose,
} from "@/lib/max-oauth";

/**
 * Обработчик возврата из OAuth MAX (Req 16.1, 16.3, 6.6).
 *
 * Читает `code`/`state` из query, сверяет `state` с сохранённым (защита от
 * CSRF) и завершает поток:
 * - `purpose='login'` → вход через MAX (`POST /auth/max`), затем переход к задачам;
 * - `purpose='link'` → привязка профиля MAX (`POST /profile/max`), затем переход
 *   в профиль.
 * При ошибке (MAX отклонил авторизацию, нет `code`, несовпадение `state` или
 * сбой backend) показывается локализованное сообщение (Req 16.3).
 */
export function MaxCallbackPage({
  purpose,
}: {
  purpose: MaxOAuthPurpose;
}): JSX.Element {
  const { t } = useTranslation();
  const { signInWithMax, setUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  /** Защита от повторного запуска обработки (StrictMode монтирует дважды). */
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const oauthError = searchParams.get("error");

    const failKey =
      purpose === "login" ? "login.maxFailed" : "profile.max.failed";
    const stateMismatchKey =
      purpose === "login"
        ? "login.maxStateMismatch"
        : "profile.max.stateMismatch";
    const noCodeKey =
      purpose === "login" ? "login.maxNoCode" : "profile.max.noCode";

    if (oauthError !== null) {
      setError(t(failKey));
      return;
    }
    if (code === null || code === "") {
      setError(t(noCodeKey));
      return;
    }

    let expectedState: string | null = null;
    try {
      expectedState = sessionStorage.getItem(MAX_OAUTH_STATE_KEY);
      sessionStorage.removeItem(MAX_OAUTH_STATE_KEY);
    } catch {
      expectedState = null;
    }
    if (expectedState !== null && state !== expectedState) {
      setError(t(stateMismatchKey));
      return;
    }

    const redirectUri = `${window.location.origin}${maxCallbackPath(purpose)}`;
    if (purpose === "login") {
      signInWithMax(code, redirectUri)
        .then(() => navigate("/tasks", { replace: true }))
        .catch(() => setError(t(failKey)));
    } else {
      linkMax(code, redirectUri)
        .then((updated) => {
          setUser(updated);
          navigate("/profile", { replace: true });
        })
        .catch(() => setError(t(failKey)));
    }
  }, [purpose, searchParams, signInWithMax, setUser, navigate, t]);

  return (
    <section className="auth-shell">
      <div className="auth-panel stack">
        <h1>{t("login.withMax")}</h1>
        {error === null ? (
          <p role="status">
            {purpose === "login"
              ? t("login.maxProcessing")
              : t("profile.max.processing")}
          </p>
        ) : (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Link
              className="btn btn--primary btn--block"
              to={purpose === "login" ? "/login" : "/profile"}
            >
              {t("common.back")}
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
