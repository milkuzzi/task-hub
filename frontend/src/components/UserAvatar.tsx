import { useTranslation } from 'react-i18next';
import { fetchAvatarBlob } from '@/lib/avatar';
import { useAuthedImage } from '@/lib/use-authed-image';

/**
 * Переиспользуемый аватар Пользователя (дефект 4, Req 2.4).
 *
 * Аватар защищён авторизацией и отдаётся по эндпоинту `GET /avatars/:userId`,
 * поэтому байты запрашиваются «fetch-as-blob» с Bearer-токеном
 * ({@link fetchAvatarBlob} + {@link useAuthedImage}) и показываются через Object
 * URL. Если вызывающий код уже получил `avatarPath: null`, байты не
 * запрашиваются и сразу показывается заглушка. Когда наличие аватара
 * неизвестно, источник истины остаётся сервер: 200 → показываем изображение,
 * 404/ошибка/нет `userId` → показываем заглушку (как в {@link AvatarUploader}).
 *
 * Изображению присваивается доступное имя «Аватар пользователя»
 * (`profile.avatar.alt`), единое с загрузчиком аватара. Заглушка декоративна
 * (`aria-hidden`), чтобы не зашумлять озвучивание для скринридеров.
 */
export interface UserAvatarProps {
  /** Идентификатор Пользователя, чей аватар показываем; `null` — заглушка. */
  userId: string | null | undefined;
  /** `false`, когда API уже сообщил, что аватара нет; `undefined` — проверить сервером. */
  hasAvatar?: boolean | undefined;
  /** Размер аватара (визуальный класс). */
  size?: 'sm' | 'md';
  /** Дополнительный CSS-класс. */
  className?: string;
}

export function UserAvatar({
  userId,
  hasAvatar,
  size = 'md',
  className,
}: UserAvatarProps): JSX.Element {
  const { t } = useTranslation();

  // Если наличие неизвестно, запрашиваем защищённый аватар; если API уже
  // вернул `avatarPath: null`, сразу показываем заглушку без сетевого 404.
  const shouldFetch = userId != null && hasAvatar !== false;
  const { src } = useAuthedImage(
    shouldFetch ? () => fetchAvatarBlob(userId) : null,
    [userId, hasAvatar],
  );

  const classes = ['user-avatar', `user-avatar--${size}`, className]
    .filter(Boolean)
    .join(' ');

  if (src !== null) {
    return <img className={classes} src={src} alt={t('profile.avatar.alt')} />;
  }

  return <span className={`${classes} user-avatar--placeholder`} aria-hidden="true" />;
}
