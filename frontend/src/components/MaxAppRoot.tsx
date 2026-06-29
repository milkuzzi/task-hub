import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ApiError, setSessionBearerToken } from "@/lib/api";
import {
  linkAndLoginWithMaxMiniApp,
  loginWithMaxMiniApp,
  type MaxMiniAppSession,
} from "@/lib/auth-api";
import { useAuth } from "@/lib/use-auth";
import {
  clearMaxLaunchFragment,
  loadMaxBridge,
  maxStartTaskPath,
  readMaxInitData,
} from "@/lib/max-bridge";
import { setSocketAuthToken } from "@/lib/socket";

type BootState = "loading" | "link" | "ready" | "error" | "outside";

export function MaxAppRoot(): JSX.Element {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const started = useRef(false);
  const [state, setState] = useState<BootState>("loading");
  const [initData, setInitData] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyMiniAppSession = useCallback(
    (session: MaxMiniAppSession): void => {
      setSessionBearerToken(session.token);
      setSocketAuthToken(session.token);
      setUser(session.user);
    },
    [setUser],
  );

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    void (async () => {
      const fragmentData = readMaxInitData();
      if (fragmentData === null) {
        await loadMaxBridge();
      } else {
        void loadMaxBridge();
      }
      const launchData = fragmentData ?? readMaxInitData();
      if (launchData === null) {
        setState("outside");
        return;
      }
      setInitData(launchData);
      clearMaxLaunchFragment();

      try {
        const session = await loginWithMaxMiniApp(launchData);
        applyMiniAppSession(session);
        if (location.pathname === "/max" || location.pathname === "/max/") {
          navigate(maxStartTaskPath(launchData) ?? "/max/tasks", { replace: true });
        }
        setState("ready");
      } catch (caught) {
        if (isNotLinkedError(caught)) {
          setState("link");
          return;
        }
        setError(caught instanceof ApiError ? caught.message : "Не удалось открыть mini-app.");
        setState("error");
      }
    })();
  }, [applyMiniAppSession, location.pathname, navigate]);

  async function handleLink(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const session = await linkAndLoginWithMaxMiniApp(
        initData,
        String(form.get("email") ?? "").trim(),
        String(form.get("password") ?? ""),
      );
      applyMiniAppSession(session);
      navigate(maxStartTaskPath(initData) ?? "/max/tasks", { replace: true });
      setState("ready");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Не удалось выполнить вход.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "ready") {
    return <Outlet />;
  }

  return (
    <main className="max-auth">
      <section className="max-auth__panel" aria-busy={state === "loading"}>
        <img className="max-auth__logo" src="/logo2090.png" alt="" width="56" height="56" />
        <h1>Система поручений</h1>
        {state === "loading" && <p className="text-muted">Подтверждаем вход через MAX…</p>}
        {state === "outside" && (
          <p className="form-error" role="alert">Откройте приложение из профиля бота в MAX.</p>
        )}
        {state === "error" && (
          <>
            <p className="form-error" role="alert">{error}</p>
            <button className="btn btn--primary" type="button" onClick={() => window.location.reload()}>
              Повторить
            </button>
          </>
        )}
        {state === "link" && (
          <form className="stack max-auth__form" onSubmit={(event) => void handleLink(event)}>
            <label className="field">
              <span className="field__label">Email</span>
              <input className="field__input" name="email" type="email" autoComplete="username" required />
            </label>
            <label className="field">
              <span className="field__label">Пароль</span>
              <input className="field__input" name="password" type="password" autoComplete="current-password" required />
            </label>
            {error !== null && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
              {busy ? "Вход…" : "Войти и привязать"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

function isNotLinkedError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return false;
  }
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === "MAX_NOT_LINKED"
  );
}
