import { IsString } from 'class-validator';

/**
 * DTO входа через OAuth MAX (Req 16.1, 16.3).
 *
 * Содержит одноразовый код авторизации, полученный после редиректа со стороны
 * MAX. Применяется глобальным `ValidationPipe`; обмен кода и выпуск Сессии
 * выполняет {@link import('../auth.service').AuthService.loginWithMax}.
 */
export class MaxLoginDto {
  /** Одноразовый код авторизации OAuth MAX. */
  @IsString({ message: 'Код авторизации должен быть строкой.' })
  authCode!: string;
}
