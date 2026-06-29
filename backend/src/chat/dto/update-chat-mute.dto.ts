import { IsBoolean } from 'class-validator';

export class UpdateChatMuteDto {
  @IsBoolean({ message: 'Настройка уведомлений задачи должна быть логическим значением.' })
  muted!: boolean;
}
