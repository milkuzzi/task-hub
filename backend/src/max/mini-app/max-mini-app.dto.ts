import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class MaxMiniAppLoginDto {
  @IsString({ message: 'Данные запуска MAX должны быть строкой.' })
  @IsNotEmpty({ message: 'Данные запуска MAX не указаны.' })
  @MaxLength(8192, { message: 'Данные запуска MAX превышают допустимый размер.' })
  initData!: string;
}

export class MaxMiniAppLinkDto extends MaxMiniAppLoginDto {
  @IsEmail({}, { message: 'Укажите корректный адрес электронной почты.' })
  @MaxLength(254, { message: 'Адрес электронной почты слишком длинный.' })
  email!: string;

  @IsString({ message: 'Пароль должен быть строкой.' })
  @MaxLength(128, { message: 'Пароль слишком длинный.' })
  password!: string;
}
