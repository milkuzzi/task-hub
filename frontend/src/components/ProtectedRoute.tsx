import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/use-auth';

/**
 * Защита маршрутов по наличию аутентифицированной Сессии (Req 5.7).
 *
 * Пока идёт восстановление Сессии по сохранённому токену — показывает индикатор
 * загрузки. Неаутентифицированных Пользователей перенаправляет на `/login`,
 * сохраняя исходный путь для возврата после входа.
 */
export function ProtectedRoute(): JSX.Element {
  const { isAuthenticated, initializing } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();

  if (initializing) {
    return (
      <section className="auth-shell">
        <p>{t('common.loading')}</p>
      </section>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
