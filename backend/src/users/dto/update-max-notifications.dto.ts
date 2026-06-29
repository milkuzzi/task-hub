import { IsBoolean } from 'class-validator';

export class UpdateMaxNotificationsDto {
  @IsBoolean({ message: 'Настройка уведомлений MAX должна быть логическим значением.' })
  muted!: boolean;
}
