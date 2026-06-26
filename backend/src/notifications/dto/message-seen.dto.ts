import { IsString, IsNotEmpty } from 'class-validator';

/**
 * DTO просмотра уведомления о Сообщении Чата (Req 7.2, 14.4, 16.12).
 *
 * Несёт идентификатор просмотренного Сообщения, по которому очищается
 * соответствующее Уведомление текущего Пользователя на сайте и в Боте MAX.
 * Зеркалит клиентский вызов `markNotificationSeen(messageId)` из
 * `frontend/src/lib/notifications-api.ts`, отправляющий тело `{ messageId }`.
 * Применяется глобальным `ValidationPipe` (whitelist + transform); нарушения
 * преобразуются глобальным фильтром в единый формат `{ code, message }`
 * (Req 1.1).
 */
export class MessageSeenDto {
  /** Идентификатор просмотренного Сообщения — обязательная непустая строка. */
  @IsString({ message: 'Идентификатор сообщения должен быть строкой.' })
  @IsNotEmpty({ message: 'Идентификатор сообщения обязателен.' })
  messageId!: string;
}
