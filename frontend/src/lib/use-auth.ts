import { createContext, useContext } from "react";
import type { AuthSession, CurrentUser } from "./auth-api";

/**
 * Контекст и хук доступа к состоянию аутентификации.
 *
 * Вынесены в отдельный модуль от `AuthProvider`, чтобы файл провайдера
 * экспортировал только компонент (требование react-refresh).
 */

export interface AuthContextValue {
  /** Текущий Пользователь или null, если не аутентифицирован. */
  user: CurrentUser | null;
  /** Идёт первичная проверка сохранённой Сессии. */
  initializing: boolean;
  /** Аутентифицирован ли Пользователь. */
  isAuthenticated: boolean;
  /** Вход по email/паролю (Req 5.7). */
  signIn: (email: string, password: string) => Promise<void>;
  /** Вход через MAX: новый flow через Бота или legacy OAuth при переданном коде. */
  signInWithMax: (authCode?: string, redirectUri?: string) => Promise<void>;
  /** Выход из Системы (Req 19.10). */
  signOut: () => Promise<void>;
  /** Обновить профиль в контексте (после смены аватара/привязки MAX). */
  setUser: (user: CurrentUser) => void;
}

/** Тип сессии переэкспортируется для удобства потребителей контекста. */
export type { AuthSession };

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Хук доступа к контексту аутентификации. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth должен использоваться внутри <AuthProvider>");
  }
  return ctx;
}
