import { useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bell, CheckSquareOffset, ShieldCheck, UserCircle } from "@phosphor-icons/react";
import { useAuth } from "@/lib/use-auth";

const ROOT_PATHS = new Set([
  "/max/tasks",
  "/max/notifications",
  "/max/profile",
  "/max/admin",
]);

export function MaxAppLayout(): JSX.Element {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const button = window.WebApp?.BackButton;
    if (button === undefined) {
      return;
    }
    const onBack = (): void => navigate(-1);
    if (ROOT_PATHS.has(location.pathname)) {
      button.hide();
    } else {
      button.show();
      button.onClick(onBack);
    }
    return () => button.offClick(onBack);
  }, [location.pathname, navigate]);

  const itemClass = ({ isActive }: { isActive: boolean }): string =>
    isActive ? "max-nav__item is-active" : "max-nav__item";

  return (
    <div className="max-app">
      <header className="max-app__header">
        <img src="/logo2090.png" alt="" width="24" height="24" />
        <span>Система поручений</span>
      </header>
      <main className="max-app__content"><Outlet /></main>
      <nav className="max-nav" aria-label="Основная навигация">
        <NavLink to="/max/tasks" className={itemClass}>
          <CheckSquareOffset size={22} aria-hidden="true" /><span>Задачи</span>
        </NavLink>
        <NavLink to="/max/notifications" className={itemClass}>
          <Bell size={22} aria-hidden="true" /><span>Уведомления</span>
        </NavLink>
        {user?.role === "ADMIN" && (
          <NavLink to="/max/admin" className={itemClass}>
            <ShieldCheck size={22} aria-hidden="true" /><span>Управление</span>
          </NavLink>
        )}
        <NavLink to="/max/profile" className={itemClass}>
          <UserCircle size={22} aria-hidden="true" /><span>Профиль</span>
        </NavLink>
      </nav>
    </div>
  );
}
