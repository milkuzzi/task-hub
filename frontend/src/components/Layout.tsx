import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChartBar,
  CheckSquareOffset,
  SignOut,
  Users,
} from '@phosphor-icons/react';
import { useAuth } from '@/lib/use-auth';
import { UserAvatar } from '@/components/UserAvatar';
import { NotificationsPopover } from '@/components/NotificationsPopover';

/**
 * Каркас приложения: боковая панель навигации на десктопе, верхний bar на мобиле.
 *
 * Боковая панель содержит лого-марку, навигацию с иконками и блок Пользователя
 * с аватаром и кнопкой выхода. Состав навигации зависит от роли (Req 5.7).
 * На узких экранах панель скрыта, навигация переносится в верхний bar.
 */

function LogoMark({ size = 24 }: { size?: number }): JSX.Element {
  return (
    <img
      className="app-logo"
      src="/logo2090.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
    />
  );
}

export function Layout(): JSX.Element {
  const { t } = useTranslation();
  const { isAuthenticated, signOut, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    isActive ? 'is-active' : '';

  async function handleLogout(): Promise<void> {
    await signOut();
    navigate('/login', { replace: true });
  }

  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  useEffect(() => {
    const resetScroll = (): void => window.scrollTo({ top: 0, left: 0 });
    resetScroll();
    const frameId = window.requestAnimationFrame(resetScroll);
    const timeoutIds = [0, 50, 150, 300].map((delay) =>
      window.setTimeout(resetScroll, delay),
    );
    return () => {
      window.cancelAnimationFrame(frameId);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [location.pathname, location.search]);

  const showSidebar = isAuthenticated && user?.role === 'ADMIN';
  const showStandaloneHeader = isAuthenticated && !showSidebar;

  return (
    <div className={showStandaloneHeader ? 'app-shell app-shell--topbar' : 'app-shell'}>
      {/* === Боковая панель (десктоп) === */}
      {showSidebar && (
        <aside className="app-sidebar">
          <NavLink to="/tasks" className="app-sidebar__brand">
            <LogoMark size={24} />
            {t('app.title')}
          </NavLink>

          <nav className="app-sidebar__nav" aria-label={t('nav.tasks')}>
            <NavLink to="/tasks" className={linkClass}>
              <CheckSquareOffset size={18} aria-hidden="true" />
              <span>{t('nav.tasks')}</span>
            </NavLink>
            {user?.role === 'ADMIN' && (
              <NavLink to="/statistics" className={linkClass}>
                <ChartBar size={18} aria-hidden="true" />
                <span>{t('nav.statistics')}</span>
              </NavLink>
            )}
            {user?.role === 'ADMIN' && (
              <NavLink to="/admin/users" className={linkClass}>
                <Users size={18} aria-hidden="true" />
                <span>{t('nav.users')}</span>
              </NavLink>
            )}
          </nav>

          <div className="app-sidebar__divider" />

          {user !== null && (
            <div className="app-sidebar__user">
              <NavLink to="/profile" className="app-sidebar__user-link">
                <UserAvatar userId={user.id} hasAvatar={user.avatarPath !== null} size="sm" />
                <div className="app-sidebar__user-info">
                  <span className="app-sidebar__user-name">{user.name}</span>
                </div>
              </NavLink>
              <button className="app-sidebar__logout" type="button" onClick={handleLogout} aria-label={t('nav.logout')}>
                <SignOut size={18} aria-hidden="true" />
              </button>
            </div>
          )}
        </aside>
      )}

      {/* === Верхний bar (мобил) === */}
      {isAuthenticated && (
        <header className={showStandaloneHeader ? 'app-header app-header--standalone' : 'app-header'}>
          <div className="app-header__inner">
            <span className="app-header__brand">
              <LogoMark size={22} />
              {t('app.title')}
            </span>
            <div className="app-header__actions">
              {showStandaloneHeader && <NotificationsPopover />}
              <nav className="app-nav" aria-label={t('nav.tasks')}>
                <NavLink to="/tasks" className={linkClass}>{t('nav.tasks')}</NavLink>
                {user?.role === 'ADMIN' && (
                  <NavLink to="/statistics" className={linkClass}>{t('nav.statistics')}</NavLink>
                )}
                {user?.role === 'ADMIN' && (
                  <NavLink to="/admin/users" className={linkClass}>{t('nav.users')}</NavLink>
                )}
                <NavLink to="/profile" className={linkClass}>{t('nav.profile')}</NavLink>
                <button className="app-nav__button" type="button" onClick={handleLogout}>
                  {t('nav.logout')}
                </button>
              </nav>
            </div>
          </div>
        </header>
      )}

      {/* === Контент === */}
      <main className={showSidebar ? 'app-main' : 'app-main app-main--no-sidebar'}>
        <Outlet />
      </main>
    </div>
  );
}
