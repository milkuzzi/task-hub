import { IsEmail, IsString } from 'class-validator';

/**
 * DTO входа по адресу электронной почты и паролю (Req 5.7, 5.8).
 *
 * Применяется глобальным `ValidationPipe` (whitelist + transform): посторонние
 * поля отбрасываются, нарушения формата преобразуются глобальным фильтром
 * исключений в единый формат `{ code, message, details? }` (Req 1.1). Сами
 * учётные данные дополнительно проверяются {@link import('../auth.service').AuthService.login};
 * единое сообщение об ошибке намеренно не указывает конкретное поле (Req 5.8).
 */
export class LoginDto {
  /** Адрес электронной почты Пользователя. */
  @IsEmail({}, { message: 'Адрес электронной почты имеет недопустимый формат.' })
  email!: string;

  /** Пароль в открытом виде. */
  @IsString({ message: 'Пароль должен быть строкой.' })
  password!: string;
}
