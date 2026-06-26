import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { tokenStore, setAuthRefreshHandler } from './api';
import { connectSocket, disconnectSocket, reauthSocket } from './socket';
import {
  fetchMe,
  login as apiLogin,
  loginWithMax as apiLoginWithMax,
  logout as apiLogout,
  refreshSession as apiRefreshSession,
  type AuthSession,
  type CurrentUser,
} from './auth-api';
import { AuthContext, type AuthContextValue } from './use-auth';

/**
 * Провайдер состояния аутентификации клиента.
 *
 * Хранит профиль текущего Пользователя и токен Сессии (Req 5.7). Токен
 * сохраняется в `localStorage`, чтобы Сессия переживала перезагрузку страницы,
 * и синхронизируется с `tokenStore` (заголовок Authorization в `api.ts`).
 * Socket.IO подключается после входа и отключается при выходе (Req 11.1, 19.10).
 */

const TOKEN_STORAGE_KEY = 'session_token';

/**
 * Интервал проактивного продления Сессии (скользящая сессия, Req 2.9;
 * исправление дефекта 9). TTL токена не раскрывается клиенту, поэтому
 * используется консервативный фиксированный интервал заметно меньше TTL по
 * умолчанию (15 минут): продлеваем каждые ~10 минут, пока Пользователь
 * аутентифицирован, чтобы активная работа не прерывалась преждевременным 401.
 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** Читает сохранённый токен Сессии из localStorage. */
function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Сохраняет либо очищает токен Сессии (localStorage + tokenStore). */
function persistToken(token: string | null): void {
  try {
    if (token === null) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // localStorage может быть недоступен (приватный режим) — токен останется в памяти.
  }
  tokenStore.set(token);
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
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUserState] = useState<CurrentUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  // Единый in-flight промис продления Сессии. Все источники продления
  // (таймер, возврат на вкладку, авто-повтор при 401) проходят через него,
  // поэтому одновременные продления не запускают несколько `POST /auth/refresh`
  // и не аннулируют токены друг друга (исправление гонки дефекта 9).
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);

  const refreshSession = useCallback((): Promise<string | null> => {
    if (refreshInFlightRef.current === null) {
      refreshInFlightRef.current = apiRefreshSession()
        .then((session) => {
          persistToken(session.token);
          setUserState((current) =>
            isSameCurrentUser(current, session.user) ? current : session.user,
          );
          // Сервер выпускает новый `jti` и аннулирует прежний (спек 27.1),
          // поэтому живому сокету нужно переподключиться с новым токеном,
          // иначе соединение окажется с аннулированным токеном.
          reauthSocket();
          return session.token;
        })
        .catch(() => null)
        .finally(() => {
          refreshInFlightRef.current = null;
        });
    }
    return refreshInFlightRef.current;
  }, []);

  const applySession = useCallback((session: AuthSession): void => {
    persistToken(session.token);
    setUserState(session.user);
    connectSocket();
  }, []);

  const clearSession = useCallback((): void => {
    persistToken(null);
    setUserState(null);
    disconnectSocket();
  }, []);

  // Восстановление Сессии по сохранённому токену при первом монтировании.
  useEffect(() => {
    const token = readStoredToken();
    if (token === null) {
      setInitializing(false);
      return;
    }
    tokenStore.set(token);
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
        if (!cancelled) {
          persistToken(null);
        }
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
    async (authCode: string): Promise<void> => {
      const session = await apiLoginWithMax(authCode);
      applySession(session);
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
      if (document.visibilityState === 'visible') {
        renew();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', renew);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', renew);
    };
  }, [isAuthenticated, refreshSession]);

  // Регистрируем обработчик авто-продления для интерсептора 401 (api.ts):
  // при первом 401 он прозрачно продлевает действующую Сессию и повторяет
  // запрос через общий in-flight промис; при реальной недействительности
  // (продление вернуло null) — очищает Сессию (Req 3.9).
  useEffect(() => {
    setAuthRefreshHandler(async () => {
      const token = await refreshSession();
      if (token === null) {
        clearSession();
      }
      return token;
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
