import { IsString } from 'class-validator';

/**
 * DTO смены собственного пароля аутентифицированным Пользователем (Req 6.1, 6.7).
 *
 * Содержит текущий и новый пароль. Корректность текущего пароля, длина нового и
 * запрет совпадения проверяются в
 * {@link import('../auth.service').AuthService.changePassword}; при любом
 * отклонении действующий пароль остаётся неизменным (Req 6.7).
 */
export class ChangePasswordDto {
  /** Текущий пароль в открытом виде. */
  @IsString({ message: 'Текущий пароль должен быть строкой.' })
  currentPassword!: string;

  /** Новый пароль в открытом виде. */
  @IsString({ message: 'Новый пароль должен быть строкой.' })
  newPassword!: string;
}
