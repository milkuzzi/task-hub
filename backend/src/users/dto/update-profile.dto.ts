import { IsString, MaxLength, MinLength } from 'class-validator';

/** DTO изменения собственного профиля через `/profile`. */
export class UpdateProfileDto {
  /** Новое отображаемое имя текущего пользователя. */
  @IsString({ message: 'Имя пользователя должно быть строкой.' })
  @MinLength(1, { message: 'Имя пользователя не может быть пустым.' })
  @MaxLength(200, { message: 'Имя пользователя не должно превышать 200 символов.' })
  name!: string;
}
