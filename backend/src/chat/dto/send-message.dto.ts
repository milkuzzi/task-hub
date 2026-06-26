import { ArrayMaxSize, IsArray, IsOptional, IsString, Length } from 'class-validator';

/**
 * Границы параметров Сообщения Чата (Req 11.3, 11.4, 11.9).
 *
 * Единый источник истины для DTO-границ контроллера и прикладной валидации
 * {@link ChatService.sendMessage}/{@link ChatService.editMessage}: длина текста
 * 1–4000 символов (Req 11.3, 11.4), не более 10 Вложений на одно Сообщение
 * (Req 11.9). Значения зеркалят клиентские константы
 * `frontend/src/lib/chat-api.ts` (`MESSAGE_TEXT_BOUNDS`,
 * `ATTACHMENTS_PER_MESSAGE_MAX`). Для отправки Сообщения текст может быть
 * пустым только при наличии Вложений; это условное правило проверяет
 * {@link ChatService.sendMessage}.
 */
export const MESSAGE_PARAM_BOUNDS = {
  /** Минимальная длина текста Сообщения (Req 11.3, 11.4). */
  textMinLength: 1,
  /** Максимальная длина текста Сообщения (Req 11.3, 11.4). */
  textMaxLength: 4000,
  /** Максимум Вложений на одно Сообщение (Req 11.9). */
  attachmentsMax: 10,
} as const;

/**
 * DTO отправки Сообщения в Чат Задачи (Req 11.3, 11.4, 11.9).
 *
 * Применяется глобальным `ValidationPipe` (whitelist + transform): длина текста
 * проверяется декоратором по верхней границе, превышение лимита Вложений
 * отклоняется до изменения состояния (Req 11.4). Условная обязательность текста
 * (1..4000 без Вложений, 0..4000 с Вложениями) дополнительно проверяется в
 * {@link ChatService.sendMessage}, чтобы инвариант текста (Req 11.3, 11.4)
 * выполнялся независимо от точки входа (REST, Бот MAX, внутренние вызовы).
 * Нарушения преобразуются глобальным фильтром в единый формат
 * `{ code, message, details? }` (Req 1.1).
 */
export class SendMessageDto {
  /** Текст Сообщения — 0..4000 символов; пустой допустим только с Вложениями. */
  @IsString({ message: 'Текст сообщения должен быть строкой.' })
  @Length(0, MESSAGE_PARAM_BOUNDS.textMaxLength, {
    message: `Длина текста сообщения не должна превышать ${MESSAGE_PARAM_BOUNDS.textMaxLength} символов.`,
  })
  text!: string;

  /**
   * Идентификаторы прикрепляемых Вложений — необязательно, не более 10
   * (Req 11.9). Привязка Вложений к Сообщению выполняется AttachmentsModule
   * (задача 6); здесь принимаются и валидируются только идентификаторы.
   */
  @IsOptional()
  @IsArray({ message: 'Вложения должны быть переданы списком идентификаторов.' })
  @ArrayMaxSize(MESSAGE_PARAM_BOUNDS.attachmentsMax, {
    message: `Число Вложений не может превышать ${MESSAGE_PARAM_BOUNDS.attachmentsMax}.`,
  })
  @IsString({ each: true, message: 'Идентификатор Вложения должен быть строкой.' })
  attachmentIds?: string[];
}
