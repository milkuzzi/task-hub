import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/use-auth';
import {
  buildMaxOAuthUrl,
  generateOAuthState,
  MAX_OAUTH_STATE_KEY,
} from '@/lib/max-oauth';

/**
 * Привязка собственного профиля MAX (Req 6.6, 16.2).
 *
 * Отображает текущий статус привязки и кнопку запуска OAuth-перехода. После
 * возврата из MAX привязка завершается на `MaxCallbackPage` (`POST /profile/max`).
 */
export function MaxLinkSection(): JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();

  function handleLink(): void {
    const state = generateOAuthState();
    try {
      sessionStorage.setItem(MAX_OAUTH_STATE_KEY, state);
    } catch {
      // sessionStorage может быть недоступен — переход всё равно выполним.
    }
    window.location.href = buildMaxOAuthUrl('link', state);
  }

  return (
    <div className="stack">
      <p className={user?.maxLinked === true ? 'form-success' : 'text-muted'}>
        {user?.maxLinked === true ? t('profile.max.linked') : t('profile.max.notLinked')}
      </p>
      {user?.maxLinked !== true && (
        <button className="btn" type="button" onClick={handleLink}>
          {t('profile.max.link')}
        </button>
      )}
    </div>
  );
}
