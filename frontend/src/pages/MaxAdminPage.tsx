import { ChartBar, Users } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

export function MaxAdminPage(): JSX.Element {
  return (
    <section className="stack page-section">
      <div className="page-head">
        <div className="page-head__content"><h1>Администрирование</h1></div>
      </div>
      <nav className="max-admin-menu" aria-label="Администрирование">
        <Link className="max-admin-menu__item" to="/max/statistics">
          <ChartBar size={24} aria-hidden="true" />
          <span><strong>Статистика</strong><small>Показатели задач и выгрузка отчётов</small></span>
        </Link>
        <Link className="max-admin-menu__item" to="/max/admin/users">
          <Users size={24} aria-hidden="true" />
          <span><strong>Пользователи</strong><small>Учётные записи, роли и приглашения</small></span>
        </Link>
      </nav>
    </section>
  );
}
