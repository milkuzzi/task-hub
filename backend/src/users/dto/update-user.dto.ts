import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTO изменения учётных данных Пользователя Администратором (Req 6.2, 6.3).
 *
 * Оба поля необязательны: отсутствие поля означает «не изменять». Поле `name`
 * соответствует доменному `displayName` ({@link ProfilePatch}). Формат адреса и
 * непустота имени дополнительно проверяются в
 * {@link import('../users.service').UsersService.updateProfile}; нарушения
 * приводятся глобальным фильтром к единому формату `{ code, message }` (Req 1.1).
 */
export class UpdateUserDto {
  /** Новый адрес электронной почты (только Администратор, Req 6.2). */
  @IsOptional()
  @IsEmail({}, { message: 'Адрес электронной почты имеет недопустимый формат.' })
  email?: string;

  /** Новое отображаемое имя (только Администратор, Req 6.3). */
  @IsOptional()
  @IsString({ message: 'Имя пользователя должно быть строкой.' })
  @MinLength(1, { message: 'Имя пользователя не может быть пустым.' })
  @MaxLength(200, { message: 'Имя пользователя не должно превышать 200 символов.' })
  name?: string;
}
