import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

/**
 * DTO привязки собственного профиля MAX по коду авторизации OAuth
 * (Req 3.2 спеки; исходное ТЗ Req 6.6, 16.2).
 *
 * Поле `authCode` — одноразовый код авторизации, полученный после редиректа со
 * стороны MAX. Контроллер обменивает его на идентификатор профиля MAX через
 * порт {@link import('../../max/oauth').MaxOAuthPort} и делегирует привязку
 * {@link import('../users.service').UsersService.linkMax}. Принадлежность
 * профиля и его верификация проверяются в сервисе/адаптере OAuth; нарушения
 * приводятся глобальным фильтром к единому формату `{ code, message }`
 * (Req 1.1).
 */
export class LinkMaxDto {
  /** Одноразовый код авторизации OAuth MAX (непустая строка). */
  @IsString({ message: 'Код авторизации MAX должен быть строкой.' })
  @IsNotEmpty({ message: 'Не указан код авторизации MAX.' })
  authCode!: string;

  /** Redirect URI, использованный при получении кода авторизации. */
  @IsOptional()
  @IsString({ message: 'Redirect URI MAX должен быть строкой.' })
  @IsUrl({ require_protocol: true }, { message: 'Redirect URI MAX должен быть абсолютным URL.' })
  redirectUri?: string;
}
