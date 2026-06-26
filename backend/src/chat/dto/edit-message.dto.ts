import { IsString, Length } from 'class-validator';
import { MESSAGE_PARAM_BOUNDS } from './send-message.dto';

/**
 * DTO редактирования текста Сообщения Чата (Req 11.5, 11.4).
 *
 * Применяется глобальным `ValidationPipe`: длина нового текста проверяется на
 * 1–4000 символов до изменения состояния (исходное Сообщение не теряется при
 * нарушении, Req 11.4). Та же длина дополнительно проверяется в
 * {@link ChatService.editMessage}. Метку «изменено» (`editedAt`) проставляет
 * сервис (Req 11.5).
 */
export class EditMessageDto {
  /** Новый текст Сообщения — обязательный, 1..4000 символов (Req 11.5, 11.4). */
  @IsString({ message: 'Текст сообщения должен быть строкой.' })
  @Length(MESSAGE_PARAM_BOUNDS.textMinLength, MESSAGE_PARAM_BOUNDS.textMaxLength, {
    message: `Длина текста сообщения должна быть от ${MESSAGE_PARAM_BOUNDS.textMinLength} до ${MESSAGE_PARAM_BOUNDS.textMaxLength} символов.`,
  })
  text!: string;
}
