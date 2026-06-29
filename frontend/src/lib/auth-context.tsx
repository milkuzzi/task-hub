import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { hasSessionBearerToken, setAuthRefreshHandler, setSessionBearerToken } from "./api";
import { connectSocket, disconnectSocket, reauthSocket, setSocketAuthToken } from "./socket";
import {
  fetchMe,
  login as apiLogin,
  loginWithMax as apiLoginWithMax,
  logout as apiLogout,
  pollMaxBotLogin,
  refreshSession as apiRefreshSession,
  startMaxBotLogin,
  type AuthSession,
  type CurrentUser,
} from "./auth-api";
import { AuthContext, type AuthContextValue } from "./use-auth";

/**
 * Провайдер состояния аутентификации клиента.
 *
 * Хранит профиль текущего Пользователя (Req 5.7). Сессия живёт в HttpOnly
 * cookie, поэтому клиентский код не сохраняет bearer-токен в `localStorage`.
 * Socket.IO подключается после входа и отключается при выходе (Req 11.1, 19.10).
 */

/**
 * Интервал проактивного продления Сессии (скользящая сессия, Req 2.9;
 * исправление дефекта 9). TTL токена не раскрывается клиенту, поэтому
 * используется консервативный фиксированный интервал заметно меньше TTL по
 * умолчанию (15 минут): продлеваем каждые ~10 минут, пока Пользователь
 * аутентифицирован, чтобы активная работа не прерывалась преждевременным 401.
 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_BOT_POLL_INTERVAL_MS = 2_000;
const MAX_BOT_POLL_GRACE_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function openPendingBotWindow(): Window | null {
  try {
    return window.open("about:blank", "_blank");
  } catch {
    return null;
  }
}

function navigateBotWindow(botWindow: Window | null, link: string): void {
  if (botWindow !== null && !botWindow.closed) {
    botWindow.opener = null;
    botWindow.location.href = link;
    botWindow.focus();
    return;
  }

  const opened = window.open(link, "_blank", "noopener,noreferrer");
  if (opened === null) {
    window.location.assign(link);
  }
}

function isSameCurrentUser(a: CurrentUser | null, b: CurrentUser): boolean {
  return (
    a !== null &&
    a.id === b.id &&
    a.email === b.email &&
    a.name === b.name &&
    a.role === b.role &&
    a.avatarPath === b.avatarPath &&
    a.maxLinked === b.maxLinked
  );
}

/** Провайдер состояния аутентификации для дерева приложения. */
export function AuthProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [user, setUserState] = useState<CurrentUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  // Единый in-flight промис продления Сессии. Все источники продления
  // (таймер, возврат на вкладку, авто-повтор при 401) проходят через него,
  // поэтому одновременные продления не запускают несколько `POST /auth/refresh`
  // и не аннулируют токены друг друга (исправление гонки дефекта 9).
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null);

  const refreshSession = useCallback((): Promise<boolean> => {
    if (refreshInFlightRef.current === null) {
      refreshInFlightRef.current = apiRefreshSession()
        .then((session) => {
          setUserState((current) =>
            isSameCurrentUser(current, session.user) ? current : session.user,
          );
          // Сервер выпускает новый `jti` и аннулирует прежний (спек 27.1),
          // поэтому живому сокету нужно переподключиться, чтобы handshake взял
          // обновлённую HttpOnly-cookie.
          if (hasSessionBearerToken()) {
            setSessionBearerToken(session.token);
            setSocketAuthToken(session.token);
          }
          reauthSocket();
          return true;
        })
        .catch(() => false)
        .finally(() => {
          refreshInFlightRef.current = null;
        });
    }
    return refreshInFlightRef.current;
  }, []);

  const applySession = useCallback((session: AuthSession): void => {
    setSessionBearerToken(null);
    setSocketAuthToken(null);
    setUserState(session.user);
    connectSocket();
  }, []);

  const clearSession = useCallback((): void => {
    setSessionBearerToken(null);
    setSocketAuthToken(null);
    setUserState(null);
    disconnectSocket();
  }, []);

  // Восстановление Сессии по HttpOnly-cookie при первом монтировании.
  useEffect(() => {
    // Mini-app всегда начинает с проверки подписанных данных MAX. Нельзя
    // восстанавливать здесь произвольную cookie браузера параллельно: ответ
    // старой сессии мог бы перезаписать подтверждённую MAX-личность.
    if (window.location.pathname === "/max" || window.location.pathname.startsWith("/max/")) {
      setInitializing(false);
      return;
    }
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (cancelled) {
          return;
        }
        setUserState(me);
        connectSocket();
      })
      .catch(() => {
        // Нет действующей cookie-сессии — остаёмся в анонимном состоянии.
      })
      .finally(() => {
        if (!cancelled) {
          setInitializing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      const session = await apiLogin(email, password);
      applySession(session);
    },
    [applySession],
  );

  const signInWithMax = useCallback(
    async (authCode?: string, redirectUri?: string): Promise<void> => {
      if (typeof authCode === "string" && authCode.trim() !== "") {
        const session = await apiLoginWithMax(authCode, redirectUri);
        applySession(session);
        return;
      }

      const botWindow = openPendingBotWindow();
      try {
        const start = await startMaxBotLogin();
        navigateBotWindow(botWindow, start.link);

        const expiresAt = Date.parse(start.expiresAt);
        const stopAt = Number.isFinite(expiresAt)
          ? expiresAt + MAX_BOT_POLL_GRACE_MS
          : Date.now() + 10 * 60_000;

        while (Date.now() <= stopAt) {
          await delay(MAX_BOT_POLL_INTERVAL_MS);
          const status = await pollMaxBotLogin(start.state);

          if (status.status === "pending") {
            continue;
          }
          if (status.status === "confirmed") {
            botWindow?.close();
            applySession(status);
            return;
          }
          if (status.status === "failed") {
            throw new Error(status.reason);
          }
          throw new Error(
            "Ссылка входа через MAX устарела. Повторите попытку.",
          );
        }

        throw new Error("Ссылка входа через MAX устарела. Повторите попытку.");
      } catch (error) {
        botWindow?.close();
        throw error;
      }
    },
    [applySession],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await apiLogout();
    } catch {
      // Даже при ошибке сервера локальная Сессия должна быть сброшена.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const setUser = useCallback((next: CurrentUser): void => {
    setUserState(next);
    connectSocket();
  }, []);

  // Проактивное продление Сессии, пока Пользователь аутентифицирован
  // (скользящая сессия, Req 2.9; исправление дефекта 9). Продлеваем:
  //  - по таймеру с запасом до истечения TTL;
  //  - при возвращении на вкладку (`visibilitychange`/`focus`) — таймеры в
  //    фоновых вкладках тормозятся браузером, поэтому возврат к работе должен
  //    немедленно продлевать Сессию, не дожидаясь следующего тика.
  // При успехе сохраняем новый токен и профиль; при ошибке оставляем текущую
  // Сессию (реально аннулированная/истёкшая будет очищена при следующем 401).
  const isAuthenticated = user !== null;
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const renew = (): void => {
      // Проактивное продление: ошибки игнорируем (реально аннулированная/истёкшая
      // Сессия будет очищена при следующем 401 через интерсептор).
      void refreshSession();
    };

    const timer = window.setInterval(renew, REFRESH_INTERVAL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        renew();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", renew);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", renew);
    };
  }, [isAuthenticated, refreshSession]);

  // Регистрируем обработчик авто-продления для интерсептора 401 (api.ts):
  // при первом 401 он прозрачно продлевает действующую Сессию и повторяет
  // запрос через общий in-flight промис; при реальной недействительности
  // (продление вернуло null) — очищает Сессию (Req 3.9).
  useEffect(() => {
    setAuthRefreshHandler(async () => {
      const refreshed = await refreshSession();
      if (!refreshed) {
        clearSession();
      }
      return refreshed;
    });
    return () => setAuthRefreshHandler(null);
  }, [clearSession, refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      initializing,
      isAuthenticated: user !== null,
      signIn,
      signInWithMax,
      signOut,
      setUser,
    }),
    [user, initializing, signIn, signInWithMax, signOut, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
