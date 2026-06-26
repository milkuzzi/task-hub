import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/** Экран 404 (Req 1.1 — текст на русском). */
export function NotFoundPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="auth-shell">
      <div className="auth-panel stack not-found">
        <p className="not-found__code">404</p>
        <h1 className="not-found__title">{t('notFound.heading')}</h1>
        <p className="not-found__description">{t('notFound.description')}</p>
        <Link className="btn btn--primary" to="/tasks">
          {t('notFound.home')}
        </Link>
      </div>
    </section>
  );
}
