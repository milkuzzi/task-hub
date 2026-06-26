import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/use-auth';
import { AvatarUploader } from '@/components/AvatarUploader';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';
import { MaxLinkSection } from '@/components/MaxLinkSection';

/**
 * Экран профиля Пользователя (Req 6.1, 6.4, 6.6).
 *
 * Объединяет:
 * - просмотр основных данных (email/имя);
 * - смену собственного аватара (Req 6.4);
 * - смену собственного пароля (Req 6.1, 6.7);
 * - привязку собственного профиля MAX (Req 6.6).
 */
export function ProfilePage(): JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();

  if (user === null) {
    return (
      <section>
        <p>{t('common.loading')}</p>
      </section>
    );
  }

  return (
    <section className="stack page-section">
      <div className="page-head">
        <div className="page-head__content">
          <h1>{t('profile.heading')}</h1>
        </div>
      </div>

      <article className="panel panel--compact account-workbench">
        <section className="account-summary">
          <div>
            <h2 className="account-summary__name">{user.name}</h2>
            <p className="account-summary__line">{user.email}</p>
          </div>
          <AvatarUploader />
        </section>

        <section className="account-workbench__section">
          <h2>{t('profile.password.heading')}</h2>
          <ChangePasswordForm />
        </section>

        <section className="account-workbench__section">
          <h2>{t('profile.max.heading')}</h2>
          <MaxLinkSection />
        </section>
      </article>
    </section>
  );
}
