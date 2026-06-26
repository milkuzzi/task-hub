import { useRef, useState, type ChangeEvent } from 'react';
import { UserCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/use-auth';
import { setAvatar } from '@/lib/auth-api';
import { AVATAR_SUPPORTED_TYPES, fetchAvatarBlob, validateAvatar } from '@/lib/avatar';
import { useAuthedImage } from '@/lib/use-authed-image';
import { ApiError } from '@/lib/api';

/**
 * Загрузка собственного аватара (Req 6.4, 6.9).
 *
 * Перед отправкой выполняется клиентская проверка формата и размера (≤5 МБ);
 * при неуспехе ранее сохранённый аватар не изменяется (Req 6.9). Backend
 * выполняет авторитетную проверку и возвращает обновлённый профиль.
 */
export function AvatarUploader(): JSX.Element {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Аватар защищён авторизацией: грузим байты с Bearer-токеном по id и
  // показываем через Object URL (Req 6.4, 5.7).
  //
  // Дефект 1: ранее показ аватара был привязан ИСКЛЮЧИТЕЛЬНО к клиентскому флагу
  // `user.avatarPath`. Когда аватар реально сохранён на сервере, но `avatarPath`
  // в контексте null/устарел (не проброшен после входа/восстановления Сессии),
  // эндпоинт не запрашивался и показывалась заглушка. Теперь источником истины
  // служит сам защищённый эндпоинт: при наличии `userId` аватар всегда
  // запрашивается, а решение «есть/нет аватара» принимает сервер (200 → есть,
  // 404 → нет). `avatarPath` остаётся в зависимостях, чтобы перезапрашивать
  // картинку после загрузки нового аватара (контекст обновляется через setUser).
  const userId = user?.id;
  const avatarPath = user?.avatarPath ?? null;
  const { src: avatarSrc } = useAuthedImage(
    userId != null ? () => fetchAvatarBlob(userId) : null,
    [userId, avatarPath],
  );

  async function handleChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    setError(null);
    setSuccess(false);

    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }

    const validation = validateAvatar(file);
    if (!validation.ok) {
      setError(
        validation.reason === 'type'
          ? t('profile.avatar.errorType')
          : t('profile.avatar.errorSize'),
      );
      resetInput();
      return;
    }

    setUploading(true);
    try {
      const updated = await setAvatar(file);
      setUser(updated);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.generic'));
    } finally {
      setUploading(false);
      resetInput();
    }
  }

  function resetInput(): void {
    if (inputRef.current !== null) {
      inputRef.current.value = '';
    }
  }

  return (
    <div className="avatar-uploader">
      <div className="avatar-uploader__preview">
        {avatarSrc !== null ? (
          <img
            className="avatar-uploader__img"
            src={avatarSrc}
            alt={t('profile.avatar.alt')}
          />
        ) : (
          <span className="avatar-uploader__placeholder">
            <UserCircle size={32} aria-hidden="true" />
            <span className="visually-hidden">{t('profile.avatar.placeholder')}</span>
          </span>
        )}
      </div>

      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="form-success" role="status">
          {t('profile.avatar.updated')}
        </p>
      )}

      <label className="btn">
        {uploading ? t('profile.avatar.uploading') : t('profile.avatar.change')}
        <input
          ref={inputRef}
          type="file"
          accept={AVATAR_SUPPORTED_TYPES.join(',')}
          hidden
          onChange={handleChange}
          disabled={uploading}
        />
      </label>
    </div>
  );
}
